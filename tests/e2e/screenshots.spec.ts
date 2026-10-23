/**
 * Store screenshots (1280×800) from the production build with SYNTHETIC
 * bookmarks only. Link-check results are synthetic records written into the
 * throwaway test profile so no real sites are contacted.
 * Run: SHOTS=1 npx playwright test tests/e2e/screenshots.spec.ts
 */
import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { launch, msg, seedBookmarks, waitFor } from './harness.ts';
import { LIBRARY } from './synthetic.ts';

test.skip(!process.env.SHOTS, 'set SHOTS=1 to regenerate store screenshots');
test.setTimeout(300_000);

test('store screenshots', async () => {
  mkdirSync('store/screenshots', { recursive: true });
  const ext = await launch({ dist: 'dist' });
  try {
    const extra = [
      { path: ['Reading'], title: 'دیوان حافظ — غزلیات', url: 'https://poetry.example.ir/hafez?utm_source=share' },
      { path: ['Old stuff'], title: 'Number theory lecture notes: primes and congruences', url: 'https://math.example.edu/nt/notes.pdf' },
      { path: ['Bookmarks to sort'], title: 'Old astronomy club page', url: 'https://astro-club.example/old-page' },
      { path: ['Bookmarks to sort'], title: 'Members area', url: 'https://club.example/members' },
    ];
    const ids = await seedBookmarks(ext, [...LIBRARY, ...extra]);
    // Synthetic health results (demo data in a throwaway profile).
    await ext.bg(async (arg) => {
      const list = arg as string[];
      const now = Date.now();
      const statuses = ['reachable', 'reachable', 'reachable', 'redirected', 'reachable', 'access-restricted', 'reachable', 'timeout', 'reachable', 'reachable'];
      const shards: Record<string, Record<string, unknown>> = {};
      const nodes = await chrome.bookmarks.get(list as [string, ...string[]]);
      nodes.forEach((n, i) => {
        let status = statuses[i % statuses.length]!;
        if (n.title === 'Old astronomy club page') status = 'not-found';
        if (n.title === 'Members area') status = 'access-restricted';
        const rec = { url: n.url, status, confidence: status === 'reachable' ? 'high' : 'medium', flags: status === 'access-restricted' ? ['login-page'] : [], httpStatus: status === 'not-found' ? 404 : status === 'access-restricted' ? 403 : status === 'timeout' ? undefined : 200, checkedAt: now - (i % 7) * 3600_000, attempts: 1, finalUrl: status === 'redirected' ? `${n.url}/` : n.url, ...(status === 'not-found' ? { notFoundFirstAt: now - 7200_000, notFoundConfirmedAt: now } : {}) };
        // Same sharding as ShardedMap (FNV-1a % 64).
        let h = 0x811c9dc5;
        for (let k = 0; k < n.id.length; k++) { h ^= n.id.charCodeAt(k); h = Math.imul(h, 0x01000193); }
        const shard = `hl:${parseInt((h >>> 0).toString(36), 36) % 64}`;
        (shards[shard] ??= {})[n.id] = rec;
      });
      await chrome.storage.local.set(shards);
    }, ids);
    const page = await ext.page('dashboard.html#overview');
    await msg(page, { type: 'updateSettings', patch: { onboarded: true, destinationRootId: null } });
    const shot = async (hash: string, file: string, prep?: () => Promise<void>) => {
      await page.goto(`chrome-extension://${ext.id}/dashboard.html#${hash}`);
      await page.reload();
      await page.locator('main .section').waitFor();
      await page.evaluate(() => window.scrollTo(0, 0));
      if (prep) await prep();
      await page.waitForTimeout(400);
      await page.screenshot({ path: `store/screenshots/${file}`, fullPage: false });
    };
    await shot('overview', '1-overview-link-health.png', async () => {
      // Show the results table (synthetic link-check data) below the metrics.
      await page.evaluate(() => [...document.querySelectorAll('main .panel')].pop()!.scrollIntoView({ block: 'start' }));
      await page.evaluate(() => window.scrollBy(0, -62));
    });
    await shot('duplicates', '2-duplicates-review.png');
    // Draft taxonomy
    await msg(page, { type: 'discoverStart', provider: 'rules', folderIds: [] });
    await shot('organize', '3-taxonomy-draft.png', async () => {
      await page.locator('#organize-draft').scrollIntoViewIfNeeded();
      await page.evaluate(() => document.getElementById('organize-draft')!.scrollIntoView({ block: 'start' }));
    });
    await msg(page, { type: 'taxonomyAdopt' });
    await msg(page, { type: 'classifyStart', provider: 'rules', scope: 'all', folderIds: [] });
    await waitFor(() => ext.bg(async () => ((await chrome.storage.local.get('job:classify'))['job:classify'] as { status: string }).status), (s) => s === 'completed');
    await msg(page, { type: 'planBuild' });
    await shot('organize', '4-organization-preview.png', async () => {
      await page.evaluate(() => document.getElementById('organize-preview')!.scrollIntoView({ block: 'start' }));
    });
    // Auto-filing activity
    await msg(page, { type: 'updateSettings', patch: { autoFile: { settleSeconds: 2 } } });
    await msg(page, { type: 'autofileEnable', enabled: true });
    for (const it of [
      { title: 'Celestial mechanics: perturbation theory notes', url: 'https://cm.example/perturbation' },
      { title: 'Persian calendar: leap year rules', url: 'https://calendars.example/leap' },
      { title: 'Real estate escrow timeline', url: 'https://realty-docs.example/timeline' },
      { title: 'Home', url: 'https://unknown.example/' },
    ]) {
      await seedBookmarks(ext, [{ path: ['Inbox'], ...it }]);
      await page.waitForTimeout(300);
    }
    await waitFor(() => ext.bg(async () => ((await chrome.storage.local.get('autofile:activity'))['autofile:activity'] as unknown[] | undefined)?.length ?? 0), (n) => n >= 4, 60_000);
    await shot('activity', '5-auto-filing-activity.png');
    await expect(page.locator('main h1')).toBeVisible();
    expect(ext.errors).toEqual([]);
  } finally {
    await ext.close();
  }
});
