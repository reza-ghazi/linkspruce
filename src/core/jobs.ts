/**
 * Durable, resumable job runner.
 *
 * A job is a fixed item list plus a persisted cursor, in-flight leases, a
 * retry schedule and counters. Work is leased in bounded batches; results are
 * committed by the processor before the lease is released. If the service
 * worker dies, leases expire and reconcile() returns those items to the retry
 * queue, so processing is at-least-once and processors must be idempotent.
 * Wake-ups come from chrome.alarms or user messages, never keepalive loops.
 */
import type { Clock, KeyValueStore } from './platform.ts';
import { newId } from './store.ts';

export const JOB_SCHEMA_VERSION = 1;

export type JobStatus = 'running' | 'paused' | 'cancelled' | 'completed';

export interface JobState<O = Record<string, unknown>> {
  v: number;
  id: string;
  type: string;
  status: JobStatus;
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;
  total: number;
  cursor: number;
  completed: number;
  failed: number;
  skipped: number;
  leases: Record<string, { until: number; attempt: number }>;
  retries: Record<string, { at: number; attempt: number }>;
  /** Last error per failed item (bounded). */
  failures: Record<string, string>;
  options: O;
  pausedReason?: string;
  lastError?: string;
}

export type Outcome =
  | { id: string; kind: 'done' }
  | { id: string; kind: 'skipped'; reason?: string }
  | { id: string; kind: 'retry'; retryAt: number; error?: string }
  | { id: string; kind: 'failed'; error: string };

/** Throw from a processor to pause the whole job (budget, permission, offline). */
export class JobPause extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}

export interface ProcessContext<O> {
  job: Readonly<JobState<O>>;
  signal: AbortSignal;
  attempts: Record<string, number>;
}

export type Processor<O> = (ids: string[], ctx: ProcessContext<O>) => Promise<Outcome[]>;

export interface RunnerOptions {
  batchSize: number;
  concurrency: number;
  leaseMs: number;
  maxAttempts: number;
  /** Stop a run() call after this long; an alarm resumes the job. */
  maxRunMs: number;
  persistEveryMs: number;
}

const DEFAULTS: RunnerOptions = {
  batchSize: 1,
  concurrency: 1,
  leaseMs: 90_000,
  maxAttempts: 3,
  maxRunMs: 4 * 60_000,
  persistEveryMs: 750,
};

const MAX_FAILURE_RECORDS = 2000;

export class JobRunner<O = Record<string, unknown>> {
  readonly type: string;
  private readonly store: KeyValueStore;
  private readonly clock: Clock;
  private readonly processor: Processor<O>;
  readonly opts: RunnerOptions;
  private running: Promise<void> | null = null;
  private abort: AbortController | null = null;
  private items: string[] | null = null;
  private itemsJobId: string | null = null;
  /** Called after every persisted state change (for progress broadcasts). */
  onProgress: ((job: JobState<O>) => void) | null = null;

  constructor(type: string, store: KeyValueStore, clock: Clock, processor: Processor<O>, opts: Partial<RunnerOptions> = {}) {
    this.type = type;
    this.store = store;
    this.clock = clock;
    this.processor = processor;
    this.opts = { ...DEFAULTS, ...opts };
  }

  private get stateKey(): string {
    return `job:${this.type}`;
  }
  private itemsKey(jobId: string): string {
    return `job:${this.type}:items:${jobId}`;
  }

  async load(): Promise<JobState<O> | undefined> {
    const s = await this.store.get<JobState<O>>(this.stateKey);
    if (s && s.v !== JOB_SCHEMA_VERSION) return undefined; // future migrations go here
    return s;
  }

  private async save(state: JobState<O>): Promise<void> {
    state.updatedAt = this.clock.now();
    await this.store.set({ [this.stateKey]: state });
    this.onProgress?.(state);
  }

  private async loadItems(state: JobState<O>): Promise<string[]> {
    if (this.items && this.itemsJobId === state.id) return this.items;
    this.items = (await this.store.get<string[]>(this.itemsKey(state.id))) ?? [];
    this.itemsJobId = state.id;
    return this.items;
  }

  /** Create a new job, replacing any finished or paused one. Refuses while running. */
  async create(items: string[], options: O, replaceRunning = false): Promise<JobState<O>> {
    const prev = await this.load();
    if (prev?.status === 'running' && !replaceRunning) throw new Error(`A ${this.type} job is already running`);
    if (prev) {
      this.abort?.abort();
      await this.store.remove(this.itemsKey(prev.id));
    }
    const unique = [...new Set(items)];
    const now = this.clock.now();
    const state: JobState<O> = {
      v: JOB_SCHEMA_VERSION,
      id: newId('job_'),
      type: this.type,
      status: 'running',
      createdAt: now,
      updatedAt: now,
      total: unique.length,
      cursor: 0,
      completed: 0,
      failed: 0,
      skipped: 0,
      leases: {},
      retries: {},
      failures: {},
      options,
    };
    await this.store.set({ [this.itemsKey(state.id)]: unique });
    this.items = unique;
    this.itemsJobId = state.id;
    if (unique.length === 0) {
      state.status = 'completed';
      state.finishedAt = now;
    }
    await this.save(state);
    return state;
  }

  /** Expired leases → retry queue (due now). Safe to call any time. */
  reconcile(state: JobState<O>, now: number): boolean {
    let changed = false;
    for (const [id, lease] of Object.entries(state.leases)) {
      if (lease.until <= now) {
        delete state.leases[id];
        state.retries[id] = { at: now, attempt: lease.attempt };
        changed = true;
      }
    }
    return changed;
  }

  async pause(reason = 'user'): Promise<JobState<O> | undefined> {
    // Abort synchronously so the runner cannot persist a stale 'running' state afterwards.
    this.abort?.abort(new DOMException('Paused', 'AbortError'));
    const s = await this.load();
    if (!s || s.status !== 'running') return s;
    s.status = 'paused';
    s.pausedReason = reason;
    // In-flight items return to the retry queue without consuming an attempt.
    for (const [id, l] of Object.entries(s.leases)) s.retries[id] = { at: 0, attempt: Math.max(0, l.attempt - 1) };
    s.leases = {};
    await this.save(s);
    return s;
  }

  async resume(): Promise<JobState<O> | undefined> {
    const s = await this.load();
    if (!s || s.status !== 'paused') return s;
    s.status = 'running';
    delete s.pausedReason;
    await this.save(s);
    return s;
  }

  async cancel(): Promise<JobState<O> | undefined> {
    this.abort?.abort(new DOMException('Cancelled', 'AbortError'));
    const s = await this.load();
    if (!s || s.status === 'completed' || s.status === 'cancelled') return s;
    s.status = 'cancelled';
    s.leases = {};
    s.finishedAt = this.clock.now();
    await this.save(s);
    return s;
  }

  /** Earliest time the job has work to do, or undefined if none pending. */
  nextWakeAt(state: JobState<O>): number | undefined {
    if (state.status !== 'running') return undefined;
    if (state.cursor < state.total) return this.clock.now();
    let t = Infinity;
    for (const r of Object.values(state.retries)) t = Math.min(t, r.at);
    for (const l of Object.values(state.leases)) t = Math.min(t, l.until);
    return t === Infinity ? undefined : t;
  }

  isActive(): boolean {
    return this.running !== null;
  }

  /** Run until done, paused, out of due work, or maxRunMs elapsed. Single-flight per instance. */
  run(): Promise<void> {
    if (!this.running) {
      this.running = this.runInner().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  private async runInner(): Promise<void> {
    const state = await this.load();
    if (!state || state.status !== 'running') return;
    const items = await this.loadItems(state);
    const startedAt = this.clock.now();
    this.abort = new AbortController();
    const signal = this.abort.signal;
    if (this.reconcile(state, startedAt)) await this.save(state);

    let lastPersist = this.clock.now();
    let dirty = false;
    const flush = async (force = false) => {
      if (!dirty || signal.aborted) return;
      if (!force && this.clock.now() - lastPersist < this.opts.persistEveryMs) return;
      dirty = false;
      lastPersist = this.clock.now();
      await this.save(state!);
    };

    const leaseNext = (): { ids: string[]; attempts: Record<string, number> } | null => {
      const now = this.clock.now();
      const ids: string[] = [];
      const attempts: Record<string, number> = {};
      for (const [id, r] of Object.entries(state!.retries)) {
        if (ids.length >= this.opts.batchSize) break;
        if (r.at <= now) {
          ids.push(id);
          attempts[id] = r.attempt + 1;
          delete state!.retries[id];
        }
      }
      while (ids.length < this.opts.batchSize && state!.cursor < state!.total) {
        const id = items[state!.cursor++]!;
        ids.push(id);
        attempts[id] = 1;
      }
      if (!ids.length) return null;
      const until = now + this.opts.leaseMs;
      for (const id of ids) state!.leases[id] = { until, attempt: attempts[id]! };
      return { ids, attempts };
    };

    const apply = (outcomes: Outcome[], leased: string[], attempts: Record<string, number>) => {
      const seen = new Set<string>();
      for (const o of outcomes) {
        if (!(o.id in state!.leases)) continue; // stale or unknown
        seen.add(o.id);
        delete state!.leases[o.id];
        switch (o.kind) {
          case 'done':
            state!.completed++;
            delete state!.failures[o.id];
            break;
          case 'skipped':
            state!.skipped++;
            break;
          case 'retry':
            if ((attempts[o.id] ?? 1) >= this.opts.maxAttempts) {
              state!.failed++;
              this.recordFailure(state!, o.id, o.error ?? 'Retries exhausted');
            } else {
              state!.retries[o.id] = { at: o.retryAt, attempt: attempts[o.id] ?? 1 };
            }
            break;
          case 'failed':
            state!.failed++;
            this.recordFailure(state!, o.id, o.error);
            break;
        }
      }
      // Items the processor forgot: retry later.
      for (const id of leased) {
        if (!seen.has(id) && id in state!.leases) {
          delete state!.leases[id];
          state!.retries[id] = { at: this.clock.now() + 5000, attempt: attempts[id] ?? 1 };
        }
      }
      dirty = true;
    };

    const workers: Promise<void>[] = [];
    let pauseReason: string | null = null;
    const worker = async () => {
      while (!signal.aborted && !pauseReason && this.clock.now() - startedAt < this.opts.maxRunMs) {
        const batch = leaseNext();
        if (!batch) return;
        dirty = true;
        await flush(true); // persist leases before doing work
        try {
          const outcomes = await this.processor(batch.ids, { job: state!, signal, attempts: batch.attempts });
          if (signal.aborted) return;
          apply(outcomes, batch.ids, batch.attempts);
        } catch (e) {
          if (e instanceof JobPause) {
            pauseReason = e.reason;
            for (const id of batch.ids) {
              delete state!.leases[id];
              state!.retries[id] = { at: 0, attempt: Math.max(0, (batch.attempts[id] ?? 1) - 1) };
            }
            dirty = true;
            return;
          }
          if (signal.aborted) return;
          const msg = e instanceof Error ? e.message : String(e);
          state!.lastError = msg.slice(0, 300);
          apply(
            batch.ids.map((id) => ({ id, kind: 'retry' as const, retryAt: this.clock.now() + 10_000, error: msg })),
            batch.ids,
            batch.attempts,
          );
        }
        await flush();
      }
    };
    for (let i = 0; i < this.opts.concurrency; i++) workers.push(worker());
    await Promise.all(workers);

    // Re-read status: pause()/cancel()/create() may have written while we worked.
    const latest = await this.load();
    if (signal.aborted || !latest || latest.id !== state.id || latest.status !== 'running') {
      this.abort = null;
      return;
    }
    if (pauseReason) {
      state.status = 'paused';
      state.pausedReason = pauseReason;
    } else if (state.cursor >= state.total && !Object.keys(state.leases).length && !Object.keys(state.retries).length) {
      state.status = 'completed';
      state.finishedAt = this.clock.now();
    }
    dirty = true;
    await flush(true);
    this.abort = null;
  }

  private recordFailure(state: JobState<O>, id: string, error: string): void {
    const keys = Object.keys(state.failures);
    if (keys.length >= MAX_FAILURE_RECORDS) delete state.failures[keys[0]!];
    state.failures[id] = error.slice(0, 200);
  }

  async clear(): Promise<void> {
    const s = await this.load();
    this.abort?.abort();
    if (s) await this.store.remove([this.stateKey, this.itemsKey(s.id)]);
    this.items = null;
  }
}
