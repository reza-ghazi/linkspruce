import { expect, test } from '@playwright/test';
import { launch, msg, seedBookmarks, waitFor } from './harness.ts';

// Post-release check of the package Google serves. Opt-in:
// STORE_DIST=<unpacked store CRX without _metadata> npx playwright test tests/e2e/store-release.spec.ts
test.skip(!process.env.STORE_DIST, 'set STORE_DIST to an unpacked store package');

test('store-published LinkSpruce 1.0.0 installs and works', async () => {
  const ext = await launch({ dist: process.env.STORE_DIST });
  try {
    const m = await ext.bg(() => chrome.runtime.getManifest());
    expect(m.version).toBe('1.0.0');
    await seedBookmarks(ext, [
      { path: ['T'], title: 'Celestial mechanics: Kepler orbits', url: 'https://cm.example/kepler' },
      { path: ['T'], title: 'Number theory: primes', url: 'https://nt.example/primes' },
      { path: ['T'], title: 'Number theory: primes', url: 'https://nt.example/primes?utm_source=x' },
    ]);
    const popup = await ext.page('popup.html');
    await expect(popup.locator('.stat').nth(0)).toContainText('3');
    await expect(popup.locator('.stat').nth(1)).toContainText('1');
    const dash = await ext.page('dashboard.html#organize');
    await msg(dash, { type: 'discoverStart', provider: 'auto', folderIds: [] });
    await msg(dash, { type: 'taxonomyAdopt' });
    await msg(dash, { type: 'classifyStart', provider: 'auto', scope: 'all', folderIds: [] });
    await waitFor(() => ext.bg(async () => ((await chrome.storage.local.get('job:classify'))['job:classify'] as { status: string }).status), (s) => s === 'completed');
    const plan = await msg<{ id: string; fingerprint: string; moves: unknown[] }>(dash, { type: 'planBuild' });
    expect(plan.moves.length).toBeGreaterThan(0);
    for (const h of ['overview','duplicates','organize','activity','backup','settings']) {
      await dash.goto('chrome-extension://' + ext.id + '/dashboard.html#' + h);
      await dash.reload();
      await expect(dash.locator('main h1')).toBeVisible();
    }
    expect(ext.errors).toEqual([]);
  } finally { await ext.close(); }
});
