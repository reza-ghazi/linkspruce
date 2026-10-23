import { expect, test } from '@playwright/test';
import { startFixtureServer, type FixtureServer } from './fixture-server.ts';
import { launch, msg, seedBookmarks, waitFor, type Ext } from './harness.ts';

let srv: FixtureServer;
let ext: Ext;

test.beforeEach(async () => {
  srv = await startFixtureServer();
  ext = await launch({ fixturePort: srv.port });
});
test.afterEach(async () => {
  await ext.close();
  await srv.close();
});

type Health = Record<string, { status: string; httpStatus?: number; finalUrl?: string; flags: string[]; skipReason?: string; attempts: number; meta?: { canonical?: string; title?: string }; notFoundConfirmedAt?: number }>;

async function healthOf(ext: Ext, ids: string[]): Promise<Health> {
  return ext.bg(async (arg) => {
    const all = await chrome.storage.local.get(null);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(all)) if (k.startsWith('hl:')) Object.assign(out, v);
    return Object.fromEntries((arg as string[]).map((id) => [id, out[id]]));
  }, ids) as Promise<Health>;
}

async function job(ext: Ext) {
  return ext.bg(async () => (await chrome.storage.local.get('job:audit'))['job:audit']) as Promise<{ status: string; completed: number; failed: number; skipped: number; total: number } | undefined>;
}

test('classifies the HTTP fixture matrix conservatively, within concurrency limits, without cookies', async () => {
  const u = srv.url;
  const cases: Array<[string, string]> = [
    [u('a', '/ok'), 'reachable'],
    [u('b', '/head-405'), 'reachable'],
    [u('c', '/notfound'), 'not-found'],
    [u('d', '/gone'), 'not-found'],
    [u('e', '/forbidden'), 'access-restricted'],
    [u('f', '/unauth'), 'access-restricted'],
    [u('g', '/ratelimit'), 'reachable'],
    [u('h', '/error'), 'server-error'],
    [u('i', '/slow'), 'timeout'],
    [u('j', '/redirect'), 'redirected'],
    [u('k', '/private'), 'access-restricted'],
    [u('l', '/canonical-a'), 'reachable'],
    [u('m', '/big'), 'reachable'],
    [u('n', '/file.pdf'), 'reachable'],
    [u('o', '/soft404'), 'inconclusive'],
    [u('p', '/challenge'), 'access-restricted'],
    ['http://localhost:9/x', 'skipped'],
    ['ftp://files.example/x', 'unsupported'],
    ['javascript:void(0)', 'unsupported'],
    [u('q', '/reset?token=abcdef1234567890'), 'skipped'],
    ['https://no-permission.example/page', 'skipped'],
  ];
  // Many bookmarks on two hosts to exercise per-host spacing/limits.
  const bulk = Array.from({ length: 12 }, (_, i) => [u(i % 2 ? 'busy1' : 'busy2', `/page-${i}`), 'reachable'] as [string, string]);
  const all = [...cases, ...bulk];
  await ext.context.addCookies([{ name: 'session', value: 'secret', domain: 'a.linkspruce-fixture.example', path: '/' }]);
  const ids = await seedBookmarks(ext, all.map(([url], i) => ({ path: ['Fixtures'], title: `Fixture ${i}`, url })));
  const dash = await ext.page('dashboard.html#overview');
  await msg(dash, { type: 'updateSettings', patch: { audit: { timeoutMs: 3000, originSpacingMs: 250, maxConcurrent: 5, maxPerOrigin: 1 } } });
  await msg(dash, { type: 'auditStart', mode: 'all', folderIds: [], ids: [] });
  const done = await waitFor(() => job(ext), (j) => j?.status === 'completed', 120_000);
  expect(done!.total).toBe(all.length);
  const h = await healthOf(ext, ids);
  all.forEach(([url, expected], i) => expect.soft(h[ids[i]!]?.status, url).toBe(expected));
  expect(h[ids[0]!]!.flags).toEqual([]);
  expect(h[ids[9]!]!.finalUrl).toContain('/ok');
  expect(h[ids[11]!]!.meta?.canonical).toBe(u('l', '/canonical-target'));
  expect(h[ids[6]!]!.attempts).toBe(2); // 429 then success
  expect(h[ids[19]!]!.skipReason).toBe('sensitive');
  expect(h[ids[20]!]!.skipReason).toBe('no-permission');
  expect(h[ids[16]!]!.skipReason).toBe('private-network');
  expect(srv.stats.maxActive).toBeLessThanOrEqual(5);
  expect(srv.stats.maxPerHost).toBeLessThanOrEqual(1);
  expect(srv.stats.requests.some((r) => r.cookie)).toBe(false);
  expect(srv.stats.requests.some((r) => r.path.includes('token='))).toBe(false);
  // Dashboard shows results
  await dash.reload();
  await expect(dash.getByText('Not found (recheck pending)').first()).toBeVisible();
});

test('scan survives service worker termination and supports pause/resume/cancel', async () => {
  const ids = await seedBookmarks(ext, Array.from({ length: 30 }, (_, i) => ({ path: ['Many'], title: `P${i}`, url: srv.url(`h${i % 6}`, `/p${i}`) })));
  const dash = await ext.page('dashboard.html#overview');
  await msg(dash, { type: 'updateSettings', patch: { audit: { originSpacingMs: 600, maxConcurrent: 3 } } });
  await msg(dash, { type: 'auditStart', mode: 'all', folderIds: [], ids: [] });
  await waitFor(() => job(ext), (j) => (j?.completed ?? 0) >= 3, 30_000, 100);
  // Kill the worker mid-scan (as Chrome would after idle/limits).
  const cdp = await ext.context.newCDPSession(dash);
  await cdp.send('ServiceWorker.enable');
  await cdp.send('ServiceWorker.stopAllWorkers');
  await new Promise((r) => setTimeout(r, 500));
  // Any event (here a message; in production an alarm) wakes it; leases are reconciled and work resumes.
  await msg(dash, { type: 'ping' });
  await msg(dash, { type: 'jobControl', job: 'audit', action: 'pause' });
  const paused = await job(ext);
  expect(paused!.status).toBe('paused');
  const before = paused!.completed;
  await new Promise((r) => setTimeout(r, 1500));
  expect((await job(ext))!.completed).toBe(before); // nothing progresses while paused
  await msg(dash, { type: 'jobControl', job: 'audit', action: 'resume' });
  const done = await waitFor(() => job(ext), (j) => j?.status === 'completed', 120_000);
  expect(done!.completed + done!.skipped + done!.failed).toBe(30);
  const h = await healthOf(ext, ids);
  expect(ids.every((id) => h[id]?.status === 'reachable')).toBe(true);
  // Cancel works on a fresh run.
  await msg(dash, { type: 'auditStart', mode: 'all', folderIds: [], ids: [] });
  await msg(dash, { type: 'jobControl', job: 'audit', action: 'cancel' });
  expect((await job(ext))!.status).toBe('cancelled');
});

test('dead-link removal requires a confirmed recheck, takes a snapshot, and can be undone', async () => {
  const ids = await seedBookmarks(ext, [
    { path: ['Dead'], title: 'Gone page', url: srv.url('dead', '/gone') },
    { path: ['Dead'], title: 'Fine page', url: srv.url('fine', '/ok') },
  ]);
  const dash = await ext.page('dashboard.html#overview');
  await msg(dash, { type: 'auditStart', mode: 'all', folderIds: [], ids: [] });
  await waitFor(() => job(ext), (j) => j?.status === 'completed', 60_000);
  await expect(msg(dash, { type: 'removeApply', removeIds: [ids[0]!], reason: 'dead-links' })).rejects.toThrow(/confirmed/);
  // Simulate the recheck interval elapsing (test-only clock shift of the stored first observation).
  await ext.bg(async (id) => {
    const all = await chrome.storage.local.get(null);
    for (const [k, v] of Object.entries(all)) {
      const rec = (v as Record<string, { notFoundFirstAt?: number }>)[id as string];
      if (k.startsWith('hl:') && rec) {
        rec.notFoundFirstAt = Date.now() - 2 * 3600_000;
        await chrome.storage.local.set({ [k]: v });
      }
    }
  }, ids[0]);
  await msg(dash, { type: 'auditRetry', ids: [ids[0]] });
  await waitFor(() => job(ext), (j) => j?.status === 'completed', 60_000);
  expect((await healthOf(ext, [ids[0]!]))[ids[0]!]!.notFoundConfirmedAt).toBeTruthy();
  await expect(msg(dash, { type: 'removeApply', removeIds: [ids[1]!], reason: 'dead-links' })).rejects.toThrow(/confirmed/);
  const batch = await msg<{ id: string; snapshotId: string }>(dash, { type: 'removeApply', removeIds: [ids[0]!], reason: 'dead-links' });
  expect(batch.snapshotId).toBeTruthy();
  await waitFor(() => ext.bg(async (id) => (await chrome.bookmarks.get(id as string).catch(() => [])).length, ids[0]), (n) => n === 0, 20_000);
  await msg(dash, { type: 'batchUndo', batchId: batch.id });
  const restored = await ext.bg(async () => (await chrome.bookmarks.search({ title: 'Gone page' })).map((b) => b.parentId));
  expect(restored).toHaveLength(1);
});
