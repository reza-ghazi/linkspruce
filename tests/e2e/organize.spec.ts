import { expect, test } from '@playwright/test';
import { launch, msg, seedBookmarks, waitFor, type Ext } from './harness.ts';
import { LIBRARY } from './synthetic.ts';

let ext: Ext;
test.beforeEach(async () => {
  ext = await launch();
  await seedBookmarks(ext, LIBRARY);
});
test.afterEach(async () => ext.close());

const pathsByTitle = (e: Ext) =>
  e.bg(async () => {
    const [root] = await chrome.bookmarks.getTree();
    const out: Record<string, string[]> = {};
    const walk = (n: chrome.bookmarks.BookmarkTreeNode, path: string[]) => {
      for (const c of n.children ?? []) {
        if (c.url) (out[c.title] ??= []).push(path.join(' > '));
        else walk(c, [...path, c.title]);
      }
    };
    walk(root!, []);
    return out;
  });

test('discover → edit → approve → categorize → preview → apply → undo, through the dashboard UI', async () => {
  const before = await pathsByTitle(ext);
  const page = await ext.page('dashboard.html#organize');
  await page.getByRole('button', { name: 'Discover structure' }).click();
  await expect(page.getByRole('heading', { name: /Draft taxonomy/ })).toBeVisible();
  // Rename a category via the UI.
  const row = page.locator('.tree-row', { hasText: 'Real Estate' }).first();
  await row.getByRole('button', { name: 'Rename' }).click();
  await page.getByLabel('Name').fill('Real Estate Practice');
  await page.getByRole('button', { name: 'OK' }).click();
  await expect(page.locator('.tree-row .name', { hasText: 'Real Estate Practice' })).toBeVisible();
  await page.getByRole('button', { name: 'Approve taxonomy' }).click();
  await expect(page.getByRole('heading', { name: /Approved taxonomy/ })).toBeVisible();
  await page.getByRole('button', { name: /^Categorize with/ }).click();
  await waitFor(() => ext.bg(async () => ((await chrome.storage.local.get('job:classify'))['job:classify'] as { status: string })?.status), (s) => s === 'completed');
  await page.getByRole('button', { name: 'Build preview' }).click();
  await expect(page.locator('#organize-preview h2 .badge', { hasText: 'moves' })).toBeVisible();
  const moves = await page.locator('#organize-preview table.data tbody tr').count();
  expect(moves).toBeGreaterThan(10);
  await expect(page.locator('#organize-review')).toContainText('Home'); // weak title stays for review
  await page.getByRole('button', { name: 'Apply changes…' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Apply changes' }).click();
  const after = await waitFor(() => pathsByTitle(ext), (p) => (p['Two-body problem and Kepler orbits explained']?.[0] ?? '').includes('LinkSpruce'), 30_000);
  // Small library + Balanced preset: sub-topics fold into their areas.
  expect(after['Two-body problem and Kepler orbits explained']![0]).toBe('Other bookmarks > LinkSpruce > Astronomy & Space Science');
  expect(after['Daily horoscope and zodiac signs']![0]).toContain('Philosophy, Religions & Belief Systems');
  expect(after['Daily horoscope and zodiac signs']![0]).not.toContain('Astronomy');
  expect(after['Lunar occultation predictions for observers']![0]).toContain('Astronomy');
  expect(after['California real estate license exam prep']![0]).toContain('Real Estate Practice');
  expect(after['Home']![0]).toBe('Other bookmarks > Real estate'); // unchanged
  expect(after['تبدیل تاریخ هجری شمسی به میلادی']![0]).toContain('Calendars & Timekeeping');
  // Original folders still exist.
  const folders = await ext.bg(async () => (await chrome.bookmarks.search({})).filter((n) => !n.url).map((n) => n.title));
  expect(folders).toContain('Old stuff');
  // Undo from Backup & Restore.
  await page.goto(`chrome-extension://${ext.id}/dashboard.html#backup`);
  await page.locator('#backup-history').getByRole('button', { name: 'Undo' }).first().click();
  await page.getByRole('dialog').getByRole('button', { name: 'Undo' }).click();
  const restored = await waitFor(() => pathsByTitle(ext), (p) => !Object.values(p).flat().some((x) => x.includes('LinkSpruce')), 30_000);
  expect(restored).toEqual(before);
  const linkSpruceFolders = await ext.bg(async () => (await chrome.bookmarks.search({ title: 'LinkSpruce' })).length);
  expect(linkSpruceFolders).toBe(0);
  expect(ext.errors).toEqual([]);
});

test('re-applying after new bookmarks reuses generated folders (no duplicate trees)', async () => {
  const page = await ext.page('dashboard.html#organize');
  await msg(page, { type: 'discoverStart', provider: 'rules', folderIds: [] });
  await msg(page, { type: 'taxonomyAdopt' });
  const apply = async () => {
    const plan = await msg<{ id: string; fingerprint: string; moves: unknown[] }>(page, { type: 'planBuild' });
    if (!plan.moves.length) return 0;
    const b = await msg<{ id: string }>(page, { type: 'planApply', planId: plan.id, fingerprint: plan.fingerprint });
    await waitFor(() => ext.bg(async (id) => ((await chrome.storage.local.get('journal:index'))['journal:index'] as Array<{ id: string; status: string }>).find((x) => x.id === id)?.status, b.id), (s) => s !== 'running', 30_000);
    return plan.moves.length;
  };
  expect(await apply()).toBeGreaterThan(0);
  const countFolders = () => ext.bg(async () => (await chrome.bookmarks.search({})).filter((n) => !n.url).length);
  const n1 = await countFolders();
  await seedBookmarks(ext, [{ path: ['Inbox'], title: 'Kepler orbit determination notes', url: 'https://orbits.example/od' }]);
  const n1b = await countFolders();
  expect(await apply()).toBe(1);
  expect(await countFolders()).toBe(n1b);
  expect(n1b).toBe(n1 + 1); // only the new "Inbox" folder
  // A stale preview is refused after a taxonomy edit.
  const plan = await msg<{ id: string; fingerprint: string }>(page, { type: 'planBuild' });
  const t = await ext.bg(async () => (await chrome.storage.local.get('taxonomy:current'))['taxonomy:current'] as { categories: Array<{ id: string }> });
  await msg(page, { type: 'taxonomyEdit', target: 'current', edit: { op: 'reject', id: t.categories[0]!.id } });
  await expect(msg(page, { type: 'planApply', planId: plan.id, fingerprint: plan.fingerprint })).rejects.toThrow(/out of date|changed/);
});

test('backup download and restore into a new folder from file; malformed files are rejected', async () => {
  const page = await ext.page('dashboard.html#backup');
  const dl = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download backup (JSON)' }).click();
  const file = await (await dl).path();
  const fs = await import('node:fs');
  const json = JSON.parse(fs.readFileSync(file!, 'utf8'));
  expect(json.format).toBe('linkspruce-backup');
  expect(json.counts.bookmarks).toBe(LIBRARY.length);
  expect(JSON.stringify(json)).not.toMatch(/secret:gemini|AIza/);
  // Malformed
  await page.locator('#backup-restore input[type=file]').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{"format":"other"}') });
  await expect(page.getByText("This file can't be restored")).toBeVisible();
  // Valid
  await page.locator('#backup-restore input[type=file]').setInputFiles(file!);
  await expect(page.getByText(`${LIBRARY.length} bookmarks`)).toBeVisible();
  await page.getByRole('button', { name: 'Restore into a new folder…' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Restore' }).click();
  const count = await waitFor(() => ext.bg(async () => (await chrome.bookmarks.search({})).filter((n) => n.url).length), (n) => n === LIBRARY.length * 2, 30_000);
  expect(count).toBe(LIBRARY.length * 2);
  const restoredFolder = await ext.bg(async () => (await chrome.bookmarks.search({})).filter((n) => !n.url && n.title.startsWith('Restored Bookmarks')).length);
  expect(restoredFolder).toBe(1);
});
