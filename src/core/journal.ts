/**
 * Durable write-ahead operation journal for bookmark mutations.
 *
 * chrome.bookmarks is not transactional. Every batch is persisted before it
 * runs; each step is marked "intent" (persisted) before its API call and
 * "done" after. After a crash, intent steps are reconciled by inspecting the
 * live tree (did the move/create/remove actually happen?) instead of being
 * replayed blindly, so restarts never duplicate folders or bookmarks.
 *
 * Steps check expected state first; if the user or another device changed a
 * bookmark since planning, the step is recorded as a conflict and skipped
 * rather than overwriting the change. Undo builds an inverse batch with the
 * same safeguards and reports partial recovery precisely.
 */
import type { SnapNode } from './backup.ts';
import type { BmNode, BookmarksApi, Clock, KeyValueStore } from './platform.ts';
import { getChunked, newId, putChunked, removeChunked } from './store.ts';

export type ParentRef = { id: string } | { ref: string };

export type Step =
  | { op: 'create'; ref: string; parent: ParentRef; index?: number | undefined; title: string; url?: string | undefined; generated?: boolean | undefined }
  | { op: 'move'; id: string; to: ParentRef; index?: number | undefined; expect: { parentId: string; url?: string | undefined } }
  | { op: 'remove'; id: string; expect: { parentId: string; title: string; url?: string | undefined }; before?: (SnapNode & { parentId: string; index: number }) | undefined }
  | { op: 'remove-if-safe'; id: string; folder: boolean; expect: { title: string; url?: string | undefined } }
  | { op: 'update'; id: string; changes: { title?: string; url?: string }; expect: { title: string; url?: string | undefined } };

export type StepStatus = 'pending' | 'intent' | 'done' | 'skipped' | 'failed' | 'conflict';

export interface StepState {
  s: StepStatus;
  /** Resulting node id (create). */
  rid?: string | undefined;
  at?: number | undefined;
  err?: string | undefined;
  /** Observed position before a move/remove (for undo). */
  prev?: { parentId: string; index: number } | undefined;
}

export type BatchKind = 'organize' | 'dedupe' | 'restore' | 'autofile' | 'undo' | 'cleanup' | 'import';
export type BatchStatus = 'running' | 'applied' | 'partial' | 'failed' | 'cancelled';

export interface BatchHeader {
  id: string;
  kind: BatchKind;
  label: string;
  source: 'user' | 'autofile' | 'system';
  createdAt: number;
  finishedAt?: number | undefined;
  status: BatchStatus;
  snapshotId?: string | undefined;
  fingerprint?: string | undefined;
  taxonomyVersion?: number | undefined;
  stepCount: number;
  counts: Record<'done' | 'skipped' | 'failed' | 'conflict' | 'pending', number>;
  undoOf?: string | undefined;
  undoneBy?: string | undefined;
  /** Free-form, non-sensitive context (e.g. category path for auto-filing). */
  meta?: Record<string, string | number | boolean | null> | undefined;
}

export interface RecoveryReport {
  batchId: string;
  reconciled: number;
  resumed: number;
  conflicts: Array<{ step: number; op: string; reason: string }>;
}

const PAGE = 200;
const INTENT_GROUP = 25;
const OWN_TTL_MS = 10 * 60_000;
const MAX_INDEX = 60;

export class JournalError extends Error {}

interface OwnOp {
  at: number;
  /** Expected new parent for a move. */
  parentId?: string | undefined;
  /** Expected values for an update. */
  title?: string | undefined;
  url?: string | undefined;
  kind: 'move' | 'update' | 'remove' | 'created';
}

/** One persisted chunk of own-operation entries (append-only; pruned by TTL). */
interface OwnChunk {
  at: number;
  ops: Record<string, OwnOp>;
  sigs: Record<string, number>;
}

export function createSignature(parentId: string, title: string, url: string | undefined): string {
  return `${parentId}\u0001${title}\u0001${url ?? ''}`;
}

export class Journal {
  private readonly store: KeyValueStore;
  private readonly api: BookmarksApi;
  private readonly clock: Clock;
  private chain: Promise<unknown> = Promise.resolve();
  /** In-memory own-operation registry, rebuilt from persisted chunks after a restart. */
  private ownOps: Map<string, OwnOp> | null = null;
  private ownSigs = new Map<string, number>();
  private ownIndex: Array<{ key: string; at: number }> = [];
  private ownSeq = 0;
  /** Hook for tests: called after an API call succeeds but before "done" is persisted. */
  afterApiCall: ((batchId: string, stepIndex: number) => void | Promise<void>) | null = null;

  constructor(store: KeyValueStore, api: BookmarksApi, clock: Clock) {
    this.store = store;
    this.api = api;
    this.clock = clock;
  }

  /** Serialize all mutation work in this context. */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  // ───────── persistence

  async index(): Promise<BatchHeader[]> {
    return (await this.store.get<BatchHeader[]>('journal:index')) ?? [];
  }

  async header(id: string): Promise<BatchHeader | undefined> {
    return (await this.index()).find((h) => h.id === id);
  }

  private async saveHeader(h: BatchHeader): Promise<void> {
    const idx = await this.index();
    const i = idx.findIndex((x) => x.id === h.id);
    if (i >= 0) idx[i] = h;
    else idx.push(h);
    // Retain all running batches plus the most recent finished ones.
    const finished = idx.filter((x) => x.status !== 'running');
    const drop = finished.length > MAX_INDEX ? finished.sort((a, b) => a.createdAt - b.createdAt).slice(0, finished.length - MAX_INDEX) : [];
    const keep = idx.filter((x) => !drop.includes(x));
    await this.store.set({ 'journal:index': keep });
    for (const d of drop) await this.purge(d);
  }

  private async purge(h: BatchHeader): Promise<void> {
    await removeChunked(this.store, `journal:${h.id}:steps`);
    const pages = Math.ceil(h.stepCount / PAGE);
    await this.store.remove(Array.from({ length: pages }, (_, p) => `journal:${h.id}:st:${p}`));
  }

  async steps(id: string): Promise<Step[]> {
    return (await getChunked<Step[]>(this.store, `journal:${id}:steps`)) ?? [];
  }

  async states(h: BatchHeader): Promise<StepState[]> {
    const pages = Math.ceil(h.stepCount / PAGE);
    const keys = Array.from({ length: pages }, (_, p) => `journal:${h.id}:st:${p}`);
    const got = await this.store.getMany(keys);
    const out: StepState[] = [];
    for (const k of keys) out.push(...((got[k] as StepState[] | undefined) ?? []));
    while (out.length < h.stepCount) out.push({ s: 'pending' });
    return out;
  }

  private async saveStates(h: BatchHeader, states: StepState[], indices: Iterable<number>): Promise<void> {
    const pages = new Set<number>();
    for (const i of indices) pages.add(Math.floor(i / PAGE));
    const items: Record<string, unknown> = {};
    for (const p of pages) items[`journal:${h.id}:st:${p}`] = states.slice(p * PAGE, (p + 1) * PAGE);
    if (Object.keys(items).length) await this.store.set(items);
  }

  // ───────── own-operation registry (loop prevention)

  private async loadOwn(): Promise<Map<string, OwnOp>> {
    if (this.ownOps) return this.ownOps;
    const now = this.clock.now();
    const index = ((await this.store.get<Array<{ key: string; at: number }>>('journal:own:index')) ?? []).filter((x) => now - x.at <= OWN_TTL_MS);
    const chunks = await this.store.getMany(index.map((x) => x.key));
    const ops = new Map<string, OwnOp>();
    const sigs = new Map<string, number>();
    for (const { key } of index) {
      const c = chunks[key] as OwnChunk | undefined;
      if (!c) continue;
      for (const [id, o] of Object.entries(c.ops)) ops.set(id, o);
      for (const [sg, t] of Object.entries(c.sigs)) sigs.set(sg, t);
    }
    this.ownOps = ops;
    this.ownSigs = sigs;
    this.ownIndex = index;
    return ops;
  }

  /**
   * Record expected effects of our own operations. Each call persists only a
   * small new chunk plus a compact index (no rewrite of the whole registry),
   * so cost stays proportional to the group size even for 20k-step batches.
   */
  private async markOwn(ops: Record<string, Omit<OwnOp, 'at'>>, sigs: string[]): Promise<void> {
    const mem = await this.loadOwn();
    const now = this.clock.now();
    const chunk: OwnChunk = { at: now, ops: {}, sigs: {} };
    for (const [id, o] of Object.entries(ops)) {
      const full = { ...o, at: now };
      mem.set(id, full);
      chunk.ops[id] = full;
    }
    for (const sg of sigs) {
      this.ownSigs.set(sg, now);
      chunk.sigs[sg] = now;
    }
    const key = `journal:own:${now.toString(36)}:${(this.ownSeq++).toString(36)}`;
    const expired = this.ownIndex.filter((x) => now - x.at > OWN_TTL_MS);
    this.ownIndex = [...this.ownIndex.filter((x) => now - x.at <= OWN_TTL_MS), { key, at: now }];
    await this.store.set({ [key]: chunk, 'journal:own:index': this.ownIndex });
    if (expired.length) {
      await this.store.remove(expired.map((x) => x.key));
      for (const [id, o] of mem) if (now - o.at > OWN_TTL_MS) mem.delete(id);
      for (const [sg, t] of this.ownSigs) if (now - t > OWN_TTL_MS) this.ownSigs.delete(sg);
    }
  }

  /** Forget the in-memory registry (reloaded from storage on next use). */
  invalidateOwn(): void {
    this.ownOps = null;
  }

  /**
   * True if a bookmark event was caused by LinkSpruce itself. Matches the
   * specific expected effect (target parent / values), so a later user action
   * on the same bookmark is never mistaken for ours. Survives worker restarts.
   */
  async isOwnEvent(e: { id: string; parentId?: string | undefined; title?: string | undefined; url?: string | undefined; kind: 'created' | 'moved' | 'changed' | 'removed' }): Promise<boolean> {
    const mem = await this.loadOwn();
    const now = this.clock.now();
    const fresh = (t: number | undefined) => t !== undefined && now - t <= OWN_TTL_MS;
    const op = mem.get(e.id);
    if (op && fresh(op.at)) {
      let own: boolean;
      if (e.kind === 'moved') own = op.kind === 'move' && op.parentId === e.parentId;
      else if (e.kind === 'changed') own = op.kind === 'update' && (op.title === undefined || op.title === e.title) && (op.url === undefined || op.url === e.url);
      else if (e.kind === 'removed') own = op.kind === 'remove';
      else own = op.kind === 'created';
      if (own) {
        // Consume in memory: one expected effect explains one event.
        if (e.kind !== 'created') mem.delete(e.id);
        return true;
      }
    }
    if (e.kind === 'created' && e.parentId !== undefined) {
      const sig = createSignature(e.parentId, e.title ?? '', e.url);
      if (fresh(this.ownSigs.get(sig))) {
        this.ownSigs.delete(sig);
        await this.markOwn({ [e.id]: { kind: 'created' } }, []);
        return true;
      }
    }
    return false;
  }

  // ───────── batches

  /** Persist a new batch (steps + states + header) before any mutation. */
  async begin(kind: BatchKind, label: string, steps: Step[], opts: { source: BatchHeader['source']; snapshotId?: string; fingerprint?: string; taxonomyVersion?: number; undoOf?: string; meta?: BatchHeader['meta'] }): Promise<BatchHeader> {
    validateSteps(steps);
    const h: BatchHeader = {
      id: newId('batch_'),
      kind,
      label: label.slice(0, 160),
      source: opts.source,
      createdAt: this.clock.now(),
      status: 'running',
      snapshotId: opts.snapshotId,
      fingerprint: opts.fingerprint,
      taxonomyVersion: opts.taxonomyVersion,
      stepCount: steps.length,
      counts: { done: 0, skipped: 0, failed: 0, conflict: 0, pending: steps.length },
      undoOf: opts.undoOf,
      meta: opts.meta,
    };
    try {
      await putChunked(this.store, `journal:${h.id}:steps`, steps);
      const states: StepState[] = steps.map(() => ({ s: 'pending' }));
      await this.saveStates(h, states, states.keys());
      await this.saveHeader(h);
    } catch (e) {
      await this.purge(h).catch(() => undefined);
      throw new JournalError(`Could not persist the operation journal; no changes were made (${(e as Error).message}).`);
    }
    return h;
  }

  private async getNode(id: string): Promise<BmNode | undefined> {
    try {
      const [n] = await this.api.get(id);
      return n;
    } catch {
      return undefined;
    }
  }

  private resolveParent(p: ParentRef, steps: Step[], states: StepState[]): string | undefined {
    if ('id' in p) return p.id;
    const i = steps.findIndex((s) => s.op === 'create' && s.ref === p.ref);
    return i >= 0 ? states[i]?.rid : undefined;
  }

  /** Reconcile one "intent" step against the live tree. */
  private async reconcileStep(step: Step, st: StepState, steps: Step[], states: StepState[]): Promise<StepState> {
    switch (step.op) {
      case 'move': {
        const n = await this.getNode(step.id);
        const target = this.resolveParent(step.to, steps, states);
        if (!n) return { ...st, s: 'conflict', err: 'Bookmark no longer exists' };
        if (n.parentId === target) return { ...st, s: 'done' };
        if (n.parentId === step.expect.parentId) return { ...st, s: 'pending' };
        return { ...st, s: 'conflict', err: 'Moved elsewhere by someone else' };
      }
      case 'remove':
      case 'remove-if-safe': {
        const n = await this.getNode(step.id);
        return n ? { ...st, s: 'pending' } : { ...st, s: 'done' };
      }
      case 'update': {
        const n = await this.getNode(step.id);
        if (!n) return { ...st, s: 'conflict', err: 'Bookmark no longer exists' };
        const wantTitle = step.changes.title ?? step.expect.title;
        const wantUrl = step.changes.url ?? step.expect.url;
        if (n.title === wantTitle && n.url === wantUrl) return { ...st, s: 'done' };
        if (n.title === step.expect.title && n.url === step.expect.url) return { ...st, s: 'pending' };
        return { ...st, s: 'conflict', err: 'Edited by someone else' };
      }
      case 'create': {
        const parent = this.resolveParent(step.parent, steps, states);
        if (!parent) return { ...st, s: 'pending' };
        let kids: BmNode[] = [];
        try {
          kids = await this.api.getChildren(parent);
        } catch {
          return { ...st, s: 'pending' };
        }
        const claimed = new Set(states.map((x) => x.rid).filter(Boolean));
        const since = (st.at ?? 0) - 2000;
        const match = kids
          .filter((k) => k.title === step.title && (k.url ?? undefined) === (step.url ?? undefined) && !claimed.has(k.id) && (k.dateAdded ?? 0) >= since)
          .sort((a, b) => (b.dateAdded ?? 0) - (a.dateAdded ?? 0))[0];
        return match ? { ...st, s: 'done', rid: match.id } : { ...st, s: 'pending' };
      }
    }
  }

  /** Check expected state just before executing; returns a terminal state to record, or null to proceed. */
  private async precheck(step: Step, st: StepState, steps: Step[], states: StepState[]): Promise<StepState | null> {
    switch (step.op) {
      case 'move': {
        const n = await this.getNode(step.id);
        const target = this.resolveParent(step.to, steps, states);
        if (!target) return { s: 'failed', err: 'Destination folder was not created' };
        if (!n) return { s: 'conflict', err: 'Bookmark no longer exists' };
        if (n.parentId === target && st.prev) return { ...st, s: 'done' };
        if (n.parentId !== step.expect.parentId) return { s: 'conflict', err: 'Bookmark was moved since the plan was made' };
        if (step.expect.url !== undefined && n.url !== step.expect.url) return { s: 'conflict', err: 'Bookmark URL changed since the plan was made' };
        if (n.unmodifiable) return { s: 'skipped', err: 'Managed bookmark' };
        st.prev = { parentId: n.parentId!, index: n.index ?? 0 };
        return null;
      }
      case 'remove': {
        const n = await this.getNode(step.id);
        if (!n) return { s: 'skipped', err: 'Already removed' };
        if (n.parentId !== step.expect.parentId || n.title !== step.expect.title || n.url !== step.expect.url) return { s: 'conflict', err: 'Bookmark changed since the plan was made' };
        if (n.unmodifiable) return { s: 'skipped', err: 'Managed bookmark' };
        st.prev = { parentId: n.parentId!, index: n.index ?? 0 };
        return null;
      }
      case 'remove-if-safe': {
        const n = await this.getNode(step.id);
        if (!n) return { s: 'skipped', err: 'Already removed' };
        if (n.title !== step.expect.title || n.url !== step.expect.url) return { s: 'conflict', err: 'Changed since it was created; kept' };
        if (step.folder) {
          const kids = await this.api.getChildren(step.id).catch(() => [] as BmNode[]);
          if (kids.length) return { s: 'conflict', err: 'Folder is no longer empty; kept' };
        }
        return null;
      }
      case 'update': {
        const n = await this.getNode(step.id);
        if (!n) return { s: 'conflict', err: 'Bookmark no longer exists' };
        if (n.title !== step.expect.title || n.url !== step.expect.url) return { s: 'conflict', err: 'Edited since the plan was made' };
        return null;
      }
      case 'create': {
        const parent = this.resolveParent(step.parent, steps, states);
        if (!parent) return { s: 'failed', err: 'Parent folder is missing' };
        if (step.generated && step.url === undefined) {
          // Another operation may have created the same generated folder meanwhile: adopt it.
          const kids = await this.api.getChildren(parent).catch(() => [] as BmNode[]);
          const same = kids.find((k) => k.url === undefined && k.title === step.title);
          if (same) return { s: 'skipped', rid: same.id, err: 'Reused existing folder' };
        }
        return null;
      }
    }
  }

  /** Chrome rejects indices beyond the destination's current child count; clamp to stay valid. */
  private async clampIndex(parentId: string, index: number | undefined): Promise<number | undefined> {
    if (index === undefined) return undefined;
    const kids = await this.api.getChildren(parentId).catch(() => [] as BmNode[]);
    return Math.max(0, Math.min(index, kids.length));
  }

  private async exec(step: Step, steps: Step[], states: StepState[]): Promise<string | undefined> {
    switch (step.op) {
      case 'move': {
        const parentId = this.resolveParent(step.to, steps, states)!;
        const index = await this.clampIndex(parentId, step.index);
        await this.api.move(step.id, index === undefined ? { parentId } : { parentId, index });
        return undefined;
      }
      case 'remove':
      case 'remove-if-safe':
        await this.api.remove(step.id);
        return undefined;
      case 'update':
        await this.api.update(step.id, step.changes);
        return undefined;
      case 'create': {
        const parentId = this.resolveParent(step.parent, steps, states)!;
        const d: { parentId: string; title: string; url?: string; index?: number } = { parentId, title: step.title };
        if (step.url !== undefined) d.url = step.url;
        const index = await this.clampIndex(parentId, step.index);
        if (index !== undefined) d.index = index;
        const n = await this.api.create(d);
        return n.id;
      }
    }
  }

  private ownKeys(step: Step, steps: Step[], states: StepState[]): { ops: Record<string, Omit<OwnOp, 'at'>>; sigs: string[] } {
    switch (step.op) {
      case 'create': {
        const parent = this.resolveParent(step.parent, steps, states);
        return { ops: {}, sigs: parent ? [createSignature(parent, step.title, step.url)] : [] };
      }
      case 'move':
        return { ops: { [step.id]: { kind: 'move', parentId: this.resolveParent(step.to, steps, states) } }, sigs: [] };
      case 'update':
        return { ops: { [step.id]: { kind: 'update', title: step.changes.title ?? step.expect.title, url: step.changes.url ?? step.expect.url } }, sigs: [] };
      default:
        return { ops: { [step.id]: { kind: 'remove' } }, sigs: [] };
    }
  }

  /** Run (or resume) a batch. Serialized with other batches. */
  run(batchId: string, opts: { signal?: AbortSignal; onProgress?: (h: BatchHeader) => void } = {}): Promise<BatchHeader> {
    return this.exclusive(() => this.runInner(batchId, opts));
  }

  private async runInner(batchId: string, opts: { signal?: AbortSignal; onProgress?: (h: BatchHeader) => void }): Promise<BatchHeader> {
    const h = await this.header(batchId);
    if (!h) throw new JournalError('Unknown batch');
    if (h.status !== 'running') return h;
    const steps = await this.steps(batchId);
    const states = await this.states(h);
    // Reconcile any intents left by a crash.
    const touched: number[] = [];
    for (let i = 0; i < steps.length; i++) {
      if (states[i]!.s === 'intent') {
        states[i] = await this.reconcileStep(steps[i]!, states[i]!, steps, states);
        touched.push(i);
      }
    }
    if (touched.length) await this.saveStates(h, states, touched);

    let i = 0;
    while (i < steps.length) {
      if (opts.signal?.aborted) {
        h.status = 'cancelled';
        break;
      }
      // Next group of pending steps. Creates and conditional removals depend on
      // the effects of earlier steps, so each runs alone in its own group.
      const group: number[] = [];
      while (i < steps.length && group.length < INTENT_GROUP) {
        if (states[i]!.s !== 'pending') {
          i++;
          continue;
        }
        const solo = steps[i]!.op === 'create' || steps[i]!.op === 'remove-if-safe';
        if (solo && group.length) break;
        group.push(i++);
        if (solo) break;
      }
      if (!group.length) continue;
      const ready: number[] = [];
      for (const j of group) {
        const pre = await this.precheck(steps[j]!, states[j]!, steps, states);
        if (pre) states[j] = pre;
        else ready.push(j);
      }
      // Persist intents + own-op registry BEFORE calling the API.
      const now = this.clock.now();
      const ops: Record<string, Omit<OwnOp, 'at'>> = {};
      const sigs: string[] = [];
      for (const j of ready) {
        states[j] = { ...states[j]!, s: 'intent', at: now };
        const k = this.ownKeys(steps[j]!, steps, states);
        Object.assign(ops, k.ops);
        sigs.push(...k.sigs);
      }
      await this.markOwn(ops, sigs);
      await this.saveStates(h, states, [...group]);
      for (const j of ready) {
        try {
          const rid = await this.exec(steps[j]!, steps, states);
          if (rid) await this.markOwn({ [rid]: { kind: 'created' } }, []);
          await this.afterApiCall?.(batchId, j);
          states[j] = { ...states[j]!, s: 'done', rid };
        } catch (e) {
          const msg = (e as Error).message ?? String(e);
          if (/can't find|no longer exists|not found/i.test(msg)) states[j] = { ...states[j]!, s: 'conflict', err: 'Bookmark no longer exists' };
          else states[j] = { ...states[j]!, s: 'failed', err: msg.slice(0, 160) };
        }
      }
      await this.saveStates(h, states, group);
      h.counts = tally(states);
      opts.onProgress?.(h);
    }
    h.counts = tally(states);
    if (h.status === 'running') {
      h.status = h.counts.failed + h.counts.conflict === 0 ? 'applied' : h.counts.done > 0 ? 'partial' : 'failed';
    }
    h.finishedAt = this.clock.now();
    await this.saveHeader(h);
    return h;
  }

  /** Resume any batch interrupted by a worker restart. */
  async recover(): Promise<RecoveryReport[]> {
    const reports: RecoveryReport[] = [];
    for (const h of (await this.index()).filter((x) => x.status === 'running')) {
      const statesBefore = await this.states(h);
      const intents = statesBefore.filter((s) => s.s === 'intent').length;
      const pending = statesBefore.filter((s) => s.s === 'pending').length;
      const done = await this.run(h.id);
      const after = await this.states(done);
      reports.push({
        batchId: h.id,
        reconciled: intents,
        resumed: pending,
        conflicts: after.map((s, i) => ({ s, i })).filter((x) => x.s.s === 'conflict' || x.s.s === 'failed').map((x) => ({ step: x.i, op: 'step', reason: x.s.err ?? x.s.s })),
      });
    }
    return reports;
  }

  /**
   * Build the inverse steps for a finished batch. Items return to their
   * folders in ascending original index per folder, which reproduces the
   * original order when the rest of the folder is unchanged. Generated
   * folders are removed afterwards (deepest first), only if still empty.
   */
  async inverseSteps(batchId: string): Promise<Step[]> {
    const h = await this.header(batchId);
    if (!h) throw new JournalError('Unknown batch');
    const steps = await this.steps(batchId);
    const states = await this.states(h);
    const moves: Array<{ parentId: string; index: number; steps: Step[] }> = [];
    const folderRemovals: Step[] = [];
    const updates: Step[] = [];
    for (let i = steps.length - 1; i >= 0; i--) {
      const s = steps[i]!;
      const st = states[i]!;
      if (st.s !== 'done') continue;
      switch (s.op) {
        case 'move': {
          const target = this.resolveParent(s.to, steps, states);
          if (!target) break;
          const parentId = st.prev?.parentId ?? s.expect.parentId;
          const index = st.prev?.index ?? Number.MAX_SAFE_INTEGER;
          moves.push({ parentId, index, steps: [{ op: 'move', id: s.id, to: { id: parentId }, index: st.prev?.index, expect: { parentId: target } }] });
          break;
        }
        case 'create':
          if (st.rid) folderRemovals.push({ op: 'remove-if-safe', id: st.rid, folder: s.url === undefined, expect: { title: s.title, url: s.url } });
          break;
        case 'remove':
          if (s.before) {
            const parentId = st.prev?.parentId ?? s.before.parentId;
            const index = st.prev?.index ?? s.before.index;
            moves.push({ parentId, index, steps: recreateSteps(s.before, { id: parentId }, index, `u${i}`) });
          }
          break;
        case 'update':
          updates.push({ op: 'update', id: s.id, changes: { title: s.expect.title, ...(s.expect.url !== undefined ? { url: s.expect.url } : {}) }, expect: { title: s.changes.title ?? s.expect.title, url: s.changes.url ?? s.expect.url } });
          break;
        case 'remove-if-safe':
          break; // removal of an empty generated folder needs no inverse
      }
    }
    moves.sort((a, b) => (a.parentId === b.parentId ? a.index - b.index : a.parentId.localeCompare(b.parentId)));
    // Bookmarks created by the batch (restores) are removed before the folders that contain them.
    const bookmarkRemovals = folderRemovals.filter((x) => x.op === 'remove-if-safe' && !x.folder);
    const emptyFolders = folderRemovals.filter((x) => x.op === 'remove-if-safe' && x.folder);
    return [...updates, ...moves.flatMap((m) => m.steps), ...bookmarkRemovals, ...emptyFolders];
  }

  /** Undo a finished batch via a new journaled batch. */
  async undo(batchId: string, opts: { snapshotId?: string } = {}): Promise<BatchHeader> {
    const h = await this.header(batchId);
    if (!h) throw new JournalError('Unknown batch');
    if (h.status === 'running') throw new JournalError('Batch is still running');
    if (h.undoneBy) throw new JournalError('Batch was already undone');
    const inv = await this.inverseSteps(batchId);
    const u = await this.begin('undo', `Undo: ${h.label}`, inv, { source: h.source === 'autofile' ? 'autofile' : 'user', undoOf: batchId, ...(opts.snapshotId ? { snapshotId: opts.snapshotId } : {}) });
    h.undoneBy = u.id;
    await this.saveHeader(h);
    return this.run(u.id);
  }

  /** Per-step report for UI. */
  async report(batchId: string): Promise<Array<{ index: number; op: Step['op']; id?: string; status: StepStatus; error?: string; rid?: string }>> {
    const h = await this.header(batchId);
    if (!h) return [];
    const steps = await this.steps(batchId);
    const states = await this.states(h);
    return steps.map((s, i) => {
      const r: { index: number; op: Step['op']; id?: string; status: StepStatus; error?: string; rid?: string } = { index: i, op: s.op, status: states[i]!.s };
      if ('id' in s) r.id = s.id;
      if (states[i]!.err) r.error = states[i]!.err;
      if (states[i]!.rid) r.rid = states[i]!.rid;
      return r;
    });
  }
}

function tally(states: StepState[]): BatchHeader['counts'] {
  const c = { done: 0, skipped: 0, failed: 0, conflict: 0, pending: 0 };
  for (const s of states) {
    if (s.s === 'intent' || s.s === 'pending') c.pending++;
    else c[s.s]++;
  }
  return c;
}

/** Steps that recreate a removed subtree (new ids; original ids/dates can't be restored). */
export function recreateSteps(node: SnapNode, parent: ParentRef, index: number | undefined, refPrefix: string): Step[] {
  const out: Step[] = [];
  let n = 0;
  const walk = (x: SnapNode, p: ParentRef, idx: number | undefined) => {
    const ref = `${refPrefix}_${n++}`;
    out.push({ op: 'create', ref, parent: p, index: idx, title: x.title, url: x.url });
    if (x.url === undefined) (x.children ?? []).forEach((c, ci) => walk(c, { ref }, ci));
  };
  walk(node, parent, index);
  return out;
}

export function validateSteps(steps: Step[]): void {
  const refs = new Set<string>();
  for (const s of steps) {
    if (s.op === 'create') {
      if (refs.has(s.ref)) throw new JournalError(`Duplicate step ref ${s.ref}`);
      if ('ref' in s.parent && !refs.has(s.parent.ref)) throw new JournalError(`Step refers to unknown parent ${s.parent.ref}`);
      refs.add(s.ref);
    } else if (s.op === 'move' && 'ref' in s.to && !refs.has(s.to.ref)) {
      throw new JournalError(`Move refers to unknown folder ${s.to.ref}`);
    }
  }
}
