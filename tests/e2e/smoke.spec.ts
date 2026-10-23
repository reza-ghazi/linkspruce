import { expect, test } from '@playwright/test';
import { launch, msg, seedBookmarks } from './harness.ts';

const SYNTH = [
  { path: ['Research', 'Orbits'], title: 'Orbital mechanics with Python (poliastro)', url: 'https://docs.poliastro.example/en/stable/' },
  { path: ['Research', 'Orbits'], title: 'Orbital mechanics with Python (poliastro)', url: 'https://docs.poliastro.example/en/stable/?utm_source=newsletter' },
  { path: ['Research'], title: 'Lunar crescent visibility (Yallop)', url: 'https://crescent.example/yallop' },
  { path: ['Research'], title: 'رؤیت هلال ماه', url: 'https://hilal.example.ir/' },
  { path: ['Misc'], title: 'Number theory: primes', url: 'https://math.example.edu/nt' },
  { path: ['Misc'], title: 'Number theory: primes', url: 'https://math.example.edu/nt' },
];

test('production build loads without errors and works offline without host permissions', async () => {
  const ext = await launch({ dist: 'dist' });
  try {
    const manifest = await ext.bg(() => chrome.runtime.getManifest());
    expect(manifest.permissions).toEqual(['bookmarks', 'storage', 'unlimitedStorage', 'alarms']);
    expect(manifest.host_permissions ?? []).toEqual([]);
    expect(await ext.bg(() => chrome.permissions.contains({ origins: ['https://*/*'] }))).toBe(false);
    await seedBookmarks(ext, SYNTH);

    const popup = await ext.page('popup.html');
    await expect(popup.getByText('Less clutter. Better bookmarks.')).toBeVisible();
    await expect(popup.locator('.stat').nth(0)).toContainText('6');
    await expect(popup.locator('.stat').nth(1)).toContainText('2'); // two duplicate groups

    const dash = await ext.page('dashboard.html#overview');
    await expect(dash.getByRole('heading', { name: 'Overview & Link Health' })).toBeVisible();
    await expect(dash.getByText('Online link checking needs site access')).toBeVisible();
    for (const [hash, heading] of [['duplicates', 'Duplicates Review'], ['organize', 'Organization Preview'], ['activity', 'Auto-filing Activity'], ['backup', 'Backup & Restore'], ['settings', 'Settings & Privacy'], ['welcome', 'Welcome to LinkSpruce']] as const) {
      await dash.goto(`chrome-extension://${ext.id}/dashboard.html#${hash}`);
      await expect(dash.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
    }
    // Duplicates are found offline, with tracking-parameter evidence.
    await dash.goto(`chrome-extension://${ext.id}/dashboard.html#duplicates`);
    await expect(dash.getByText('Tracking parameters only').first()).toBeVisible();
    // Offline discovery works without AI or network.
    const r = await msg<{ draft?: { categories: unknown[] } }>(dash, { type: 'discoverStart', provider: 'rules', folderIds: [] });
    expect(r.draft!.categories.length).toBeGreaterThan(0);
    // Messages are validated.
    await expect(msg(dash, { type: 'removeApply', removeIds: ['x'.repeat(100)], reason: 'duplicates' })).rejects.toThrow(/Invalid/);
    await expect(msg(dash, { type: 'bogus' })).rejects.toThrow(/Unknown message/);
    expect(ext.errors).toEqual([]);
  } finally {
    await ext.close();
  }
});

test('RTL titles render as text, never as HTML', async () => {
  const ext = await launch({ dist: 'dist' });
  try {
    await seedBookmarks(ext, [{ path: ['X'], title: '<img src=x onerror="document.title=\'pwned\'"> گاه‌شماری', url: 'https://x.example/' }]);
    const dash = await ext.page('dashboard.html#overview');
    await expect(dash.getByText('<img src=x onerror=', { exact: false })).toBeVisible();
    expect(await dash.locator('img[src="x"]').count()).toBe(0);
    expect(await dash.title()).not.toBe('pwned');
  } finally {
    await ext.close();
  }
});
