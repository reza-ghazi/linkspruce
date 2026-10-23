/**
 * Bounded request scheduler shared by link audits and auto-filing metadata
 * fetches: a global concurrency ceiling, a lower per-origin ceiling, minimum
 * spacing between requests to one origin, and per-origin cooldowns (e.g. from
 * Retry-After). State is in-memory; durable retry schedules live in job state.
 */

export interface SchedulerOptions {
  /** Hard ceiling; values above 5 are clamped. */
  maxConcurrent: number;
  maxPerOrigin: number;
  /** Minimum ms between request starts to the same origin. */
  originSpacingMs: number;
}

export const DEFAULT_SCHEDULER: SchedulerOptions = { maxConcurrent: 5, maxPerOrigin: 1, originSpacingMs: 1000 };
export const MAX_GLOBAL_CONCURRENCY = 5;

interface Waiter {
  origin: string;
  resolve: (release: () => void) => void;
  reject: (e: unknown) => void;
  signal?: AbortSignal | undefined;
}

export class RequestScheduler {
  private opts: SchedulerOptions;
  private active = 0;
  private perOrigin = new Map<string, number>();
  private lastStart = new Map<string, number>();
  private cooldownUntil = new Map<string, number>();
  private queue: Waiter[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly now: () => number;
  /** Highest observed simultaneous requests (for tests/diagnostics). */
  peakActive = 0;
  peakPerOrigin = 0;

  constructor(opts: Partial<SchedulerOptions> = {}, now: () => number = Date.now) {
    this.opts = { ...DEFAULT_SCHEDULER };
    this.now = now;
    this.configure(opts);
  }

  configure(opts: Partial<SchedulerOptions>): void {
    const merged = { ...this.opts, ...opts };
    merged.maxConcurrent = Math.max(1, Math.min(MAX_GLOBAL_CONCURRENCY, Math.floor(merged.maxConcurrent)));
    merged.maxPerOrigin = Math.max(1, Math.min(merged.maxConcurrent, Math.floor(merged.maxPerOrigin)));
    merged.originSpacingMs = Math.max(0, Math.min(60_000, merged.originSpacingMs));
    this.opts = merged;
    this.pump();
  }

  get options(): Readonly<SchedulerOptions> {
    return this.opts;
  }

  /** Delay all requests to an origin until the given time (Retry-After, 429). */
  cooldown(origin: string, untilMs: number): void {
    const prev = this.cooldownUntil.get(origin) ?? 0;
    if (untilMs > prev) this.cooldownUntil.set(origin, untilMs);
  }

  /** Wait for a slot. Call the returned release() exactly once when finished. */
  acquire(origin: string, signal?: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
        return;
      }
      const waiter: Waiter = { origin, resolve, reject, signal };
      this.queue.push(waiter);
      signal?.addEventListener(
        'abort',
        () => {
          const i = this.queue.indexOf(waiter);
          if (i >= 0) {
            this.queue.splice(i, 1);
            reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
          }
        },
        { once: true },
      );
      this.pump();
    });
  }

  async run<T>(origin: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(origin, signal);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private pump(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const now = this.now();
    let earliestWake = Infinity;
    for (let i = 0; i < this.queue.length && this.active < this.opts.maxConcurrent; ) {
      const w = this.queue[i]!;
      const inFlight = this.perOrigin.get(w.origin) ?? 0;
      const readyAt = Math.max(
        (this.lastStart.get(w.origin) ?? -Infinity) + this.opts.originSpacingMs,
        this.cooldownUntil.get(w.origin) ?? -Infinity,
      );
      if (inFlight >= this.opts.maxPerOrigin) {
        i++;
        continue;
      }
      if (readyAt > now) {
        earliestWake = Math.min(earliestWake, readyAt);
        i++;
        continue;
      }
      this.queue.splice(i, 1);
      this.start(w);
    }
    if (this.queue.length && earliestWake !== Infinity) {
      this.timer = setTimeout(() => this.pump(), Math.max(5, earliestWake - now));
    }
  }

  private start(w: Waiter): void {
    this.active++;
    const n = (this.perOrigin.get(w.origin) ?? 0) + 1;
    this.perOrigin.set(w.origin, n);
    this.lastStart.set(w.origin, this.now());
    this.peakActive = Math.max(this.peakActive, this.active);
    this.peakPerOrigin = Math.max(this.peakPerOrigin, n);
    let released = false;
    w.resolve(() => {
      if (released) return;
      released = true;
      this.active--;
      const left = (this.perOrigin.get(w.origin) ?? 1) - 1;
      if (left <= 0) this.perOrigin.delete(w.origin);
      else this.perOrigin.set(w.origin, left);
      this.pump();
    });
  }

  get pending(): number {
    return this.queue.length;
  }
  get inFlight(): number {
    return this.active;
  }
}

/** Exponential backoff with full jitter: random in [0, min(cap, base*2^attempt)]. */
export function backoffDelay(attempt: number, baseMs = 2000, capMs = 5 * 60_000, rand: () => number = Math.random): number {
  const ceiling = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt));
  return Math.round(baseMs / 2 + rand() * (ceiling - baseMs / 2));
}

/** Parse Retry-After (delta-seconds or HTTP-date) into ms from now; capped. */
export function parseRetryAfter(value: string | null | undefined, now: number, capMs = 15 * 60_000): number | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Math.min(capMs, Number(v) * 1000);
  const t = Date.parse(v);
  if (Number.isNaN(t)) return undefined;
  return Math.max(0, Math.min(capMs, t - now));
}
