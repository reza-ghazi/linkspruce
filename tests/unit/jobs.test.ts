import { describe, expect, it } from 'vitest';
import { JobPause, JobRunner, type Outcome } from '../../src/core/jobs.ts';
import { FakeStore, ManualClock } from '../helpers/fake-chrome.ts';

const ids = (n: number) => Array.from({ length: n }, (_, i) => `b${i}`);

describe('JobRunner', () => {
  it('processes all items in bounded batches and completes', async () => {
    const store = new FakeStore();
    const clock = new ManualClock();
    const seen: string[][] = [];
    const r = new JobRunner('t', store, clock, async (batch) => {
      seen.push(batch);
      return batch.map((id) => ({ id, kind: 'done' as const }));
    }, { batchSize: 7 });
    await r.create(ids(50), {});
    await r.run();
    const s = await r.load();
    expect(s).toMatchObject({ status: 'completed', completed: 50, total: 50 });
    expect(Math.max(...seen.map((b) => b.length))).toBe(7);
  });

  it('survives worker termination: expired leases are retried by a fresh runner', async () => {
    const store = new FakeStore();
    const clock = new ManualClock();
    // First "worker" hangs forever on its first batch (simulated termination).
    const dying = new JobRunner('t', store, clock, () => new Promise<Outcome[]>(() => undefined), { batchSize: 5, leaseMs: 60_000 });
    await dying.create(ids(12), {});
    void dying.run();
    await new Promise((r) => setTimeout(r, 20));
    const mid = await dying.load();
    expect(Object.keys(mid!.leases)).toHaveLength(5);

    clock.advance(61_000); // lease expiry
    const done = new Set<string>();
    const fresh = new JobRunner('t', store, clock, async (batch) => batch.map((id) => (done.add(id), { id, kind: 'done' as const })), { batchSize: 5 });
    await fresh.run();
    const s = await fresh.load();
    expect(s).toMatchObject({ status: 'completed', completed: 12 });
    expect(done.size).toBe(12);
  });

  it('pause and resume keep progress; cancel stops', async () => {
    const store = new FakeStore();
    const clock = new ManualClock();
    let calls = 0;
    const r: JobRunner = new JobRunner('t', store, clock, async (batch) => {
      calls++;
      if (calls === 2) await r.pause();
      return batch.map((id) => ({ id, kind: 'done' as const }));
    }, { batchSize: 2 });
    await r.create(ids(10), {});
    await r.run();
    let s = await r.load();
    expect(s!.status).toBe('paused');
    const before = s!.completed;
    expect(before).toBeLessThan(10);
    await r.resume();
    await r.run();
    s = await r.load();
    expect(s).toMatchObject({ status: 'completed', completed: 10 });
    await r.create(ids(4), {});
    await r.cancel();
    expect((await r.load())!.status).toBe('cancelled');
  });

  it('retries with bounded attempts and records failures', async () => {
    const store = new FakeStore();
    const clock = new ManualClock();
    const r = new JobRunner('t', store, clock, async (batch) => batch.map((id) => ({ id, kind: 'retry' as const, retryAt: clock.now(), error: 'HTTP 503' })), { maxAttempts: 3 });
    await r.create(['x'], {});
    await r.run();
    const s = await r.load();
    expect(s).toMatchObject({ status: 'completed', failed: 1 });
    expect(s!.failures.x).toBe('HTTP 503');
  });

  it('defers future retries and reports the next wake time', async () => {
    const store = new FakeStore();
    const clock = new ManualClock();
    const r = new JobRunner('t', store, clock, async (batch) => batch.map((id) => ({ id, kind: 'retry' as const, retryAt: clock.now() + 30_000 })));
    await r.create(['x'], {});
    await r.run();
    const s = await r.load();
    expect(s!.status).toBe('running');
    expect(r.nextWakeAt(s!)).toBe(clock.now() + 30_000);
  });

  it('JobPause pauses the job with a reason without consuming attempts', async () => {
    const store = new FakeStore();
    const r = new JobRunner('t', store, new ManualClock(), async () => {
      throw new JobPause('budget-exhausted');
    });
    await r.create(['a', 'b'], {});
    await r.run();
    const s = await r.load();
    expect(s).toMatchObject({ status: 'paused', pausedReason: 'budget-exhausted' });
    expect(s!.retries.a!.attempt).toBe(0);
  });
});
