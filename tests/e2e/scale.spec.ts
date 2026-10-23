/**
 * Scale test with 25,000 synthetic bookmarks in an isolated Chromium profile.
 * Opt-in (slow): SCALE=1 npx playwright test tests/e2e/scale.spec.ts
 * No network requests are made (no host permissions for these URLs).
 */
import { expect, test } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'node:fs';
import { generateLibrary } from '../fixtures/synthetic-library.ts';
import { launch, msg, waitFor } from './harness.ts';

test.skip(!process.env.SCALE, 'set SCALE=1 to run the 25k scale test');
test.setTimeout(30 * 60_000);

test('25k synthetic library: seed, render, discover, classify, preview, apply, undo', async () => {
  const N = Number(process.env.SCALE_N ?? 25_000);
  const lib = generateLibrary(N);
  const ext = await launch();
  const timings: Record<string, number> = {};
  const time = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
    const t0 = Date.now();
    const r = await fn();
    timings[label] = Date.now() - t0;
    return r;
  };
  try {
    await time('seed (chrome.bookmarks.create)', () =>
      ext.bg(async (arg) => {
        const items = arg as Array<{ path: string[]; title: string; url: string }>;
        const [root] = await chrome.bookmarks.getTree();
        const other = root!.children!.find((c) => (c as { folderType?: string }).folderType === 'other')!;
        const cache = new Map<string, string>();
        for (const it of items) {
          let parent = other.id;
          let key = '';
          for (const name of it.path) {
            key += `/${name}`;
            let id = cache.get(key);
            if (!id) cache.set(key, (id = (await chrome.bookmarks.create({ parentId: parent, title: name })).id));
            parent = id;
          }
          await chrome.bookmarks.create({ parentId: parent, title: it.title, url: it.url });
        }
      }, lib),
    );
    const page = await ext.page('dashboard.html#overview');
    const nav = async (hash: string, ready: string) =>
      time(`render ${hash}`, async () => {
        await page.goto(`chrome-extension://${ext.id}/dashboard.html#${hash}`);
        await expect(page.getByRole('heading', { name: ready, level: 1 })).toBeVisible({ timeout: 120_000 });
        await page.locator('main .section').waitFor();
      });
    await nav('overview', 'Overview & Link Health');
    await nav('duplicates', 'Duplicates Review');
    await time('offline discovery', () => msg(page, { type: 'discoverStart', provider: 'rules', folderIds: [] }));
    await nav('organize', 'Organization Preview');
    await time('approve taxonomy', () => msg(page, { type: 'taxonomyAdopt' }));
    await time('classify job (offline rules)', async () => {
      await msg(page, { type: 'classifyStart', provider: 'rules', scope: 'all', folderIds: [] });
      await waitFor(() => ext.bg(async () => ((await chrome.storage.local.get('job:classify'))['job:classify'] as { status: string }).status), (s) => s === 'completed', 600_000, 500);
    });
    const plan = await time('build preview', () => msg<{ id: string; fingerprint: string; moves: unknown[] }>(page, { type: 'planBuild' }));
    await nav('organize', 'Organization Preview');
    const batch = await time('snapshot + start apply', () => msg<{ id: string }>(page, { type: 'planApply', planId: plan.id, fingerprint: plan.fingerprint }));
    const done = await time(`apply ${plan.moves.length} moves`, () =>
      waitFor(() => ext.bg(async (id) => ((await chrome.storage.local.get('journal:index'))['journal:index'] as Array<{ id: string; status: string; counts: { done: number } }>).find((x) => x.id === id), batch.id), (h) => !!h && h.status !== 'running', 1_200_000, 1000),
    );
    expect(done!.status).toBe('applied');
    const undo = await time('undo all moves', async () => {
      await msg(page, { type: 'batchUndo', batchId: batch.id });
      return waitFor(() => ext.bg(async (id) => ((await chrome.storage.local.get('journal:index'))['journal:index'] as Array<{ undoOf?: string; status: string; counts: unknown }>).find((x) => x.undoOf === id), batch.id), (h) => !!h && h.status !== 'running', 1_200_000, 1000);
    });
    expect(undo!.status).toBe('applied');
    const mem = await page.evaluate(() => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0);
    const storage = await ext.bg(async () => chrome.storage.local.getBytesInUse(null));
    const report = { bookmarks: N, moves: plan.moves.length, timingsMs: timings, dashboardHeapMB: Math.round(mem / 1048576), storageMB: +(storage / 1048576).toFixed(1), errors: ext.errors };
    mkdirSync('test-results', { recursive: true });
    writeFileSync('test-results/scale-report.json', JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    expect(ext.errors).toEqual([]);
  } finally {
    await ext.close();
  }
});
