import { expect, test } from '@playwright/test';
import { launch, msg, seedBookmarks, waitFor, type Ext } from './harness.ts';
import { LIBRARY } from './synthetic.ts';

async function setup(ext: Ext) {
  await seedBookmarks(ext, LIBRARY.slice(0, 12));
  const page = await ext.page('dashboard.html#activity');
  await msg(page, { type: 'discoverStart', provider: 'rules', folderIds: [] });
  await msg(page, { type: 'taxonomyAdopt' });
  await msg(page, { type: 'updateSettings', patch: { autoFile: { settleSeconds: 2 } } });
  await msg(page, { type: 'autofileEnable', enabled: true });
  return page;
}
const pathOf = (ext: Ext, title: string) =>
  ext.bg(async (t) => {
    const [n] = await chrome.bookmarks.search({ title: t as string });
    if (!n) return null;
    const parts: string[] = [];
    let p = n.parentId;
    while (p && p !== '0') {
      const [f] = await chrome.bookmarks.get(p);
      parts.unshift(f!.title);
      p = f!.parentId;
    }
    return parts.join(' > ');
  }, title);

test('a newly saved bookmark is filed automatically and can be undone from the UI', async () => {
  const ext = await launch();
  try {
    const page = await setup(ext);
    await seedBookmarks(ext, [{ path: ['Inbox'], title: 'Celestial mechanics: perturbation theory', url: 'https://cm.example/perturbation' }]);
    const filed = await waitFor(() => pathOf(ext, 'Celestial mechanics: perturbation theory'), (p) => !!p?.includes('LinkSpruce'), 30_000);
    // Small taxonomy: celestial mechanics is folded into the Astronomy area, an existing suitable category.
    expect(filed).toBe('Other bookmarks > LinkSpruce > Astronomy & Space Science');
    await page.reload();
    await expect(page.getByText('Saved to Astronomy & Space Science', { exact: false }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Undo' }).first().click();
    expect(await waitFor(() => pathOf(ext, 'Celestial mechanics: perturbation theory'), (p) => p === 'Other bookmarks > Inbox', 15_000)).toBe('Other bookmarks > Inbox');
    // Not re-filed later.
    await new Promise((r) => setTimeout(r, 4000));
    expect(await pathOf(ext, 'Celestial mechanics: perturbation theory')).toBe('Other bookmarks > Inbox');
    // A new subject creates a category automatically.
    await seedBookmarks(ext, [{ path: ['Inbox'], title: 'Hiking trails and national parks guide', url: 'https://trails.example/np' }]);
    expect(await waitFor(() => pathOf(ext, 'Hiking trails and national parks guide'), (p) => !!p?.includes('LinkSpruce'), 30_000)).toBe('Other bookmarks > LinkSpruce > Everyday Life & Interests > Outdoors');
    // Ambiguous saves stay in place.
    await seedBookmarks(ext, [{ path: ['Inbox'], title: 'Home', url: 'https://unknown.example/' }]);
    await new Promise((r) => setTimeout(r, 5000));
    expect(await pathOf(ext, 'Home')).toBe('Other bookmarks > Inbox');
    expect(ext.errors).toEqual([]);
  } finally {
    await ext.close();
  }
});

test('pending auto-filing survives a browser restart', async () => {
  const ext = await launch();
  const profile = ext.profile;
  await setup(ext);
  const p2 = await ext.page('dashboard.html');
  await msg(p2, { type: 'updateSettings', patch: { autoFile: { settleSeconds: 20 } } });
  await seedBookmarks(ext, [{ path: ['Inbox'], title: 'Number theory: prime gaps', url: 'https://nt.example/gaps' }]);
  await ext.close(true); // quit before the settle period ends
  const again = await launch({ profile });
  try {
    // Startup reconciles the persisted queue; the alarm/timer files it after the settle period.
    expect(await waitFor(() => pathOf(again, 'Number theory: prime gaps'), (p) => !!p?.includes('LinkSpruce'), 90_000, 1000)).toContain('Number Theory');
  } finally {
    await again.close();
  }
});
