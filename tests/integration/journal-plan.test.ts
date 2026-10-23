import { describe, expect, it } from 'vitest';
import { RulesClassifier, type Assignment } from '../../src/core/classify/classifier.ts';
import { Journal } from '../../src/core/journal.ts';
import { buildOrganizePlan, folderMapFromResults, planToSteps, type FolderMapEntry, type PlanSettings } from '../../src/core/plan.ts';
import { flattenTree, discoverRoots } from '../../src/core/tree.ts';
import { SnapshotStore } from '../../src/core/backup.ts';
import { FakeBookmarks, FakeStore, ManualClock } from '../helpers/fake-chrome.ts';
import { seed, testTaxonomy } from '../helpers/fixtures.ts';

async function setup() {
  const bm = new FakeBookmarks({ managed: true });
  const store = new FakeStore();
  const clock = new ManualClock();
  const journal = new Journal(store, bm, clock);
  const ids = await seed(bm);
  const tax = testTaxonomy();
  return { bm, store, clock, journal, ids, tax };
}

async function plan(bm: FakeBookmarks, tax: ReturnType<typeof testTaxonomy>, folderMap = new Map<string, FolderMapEntry>(), settings: Partial<PlanSettings> = {}) {
  const [tree] = await bm.getTree();
  const flat = flattenTree(tree!);
  const roots = discoverRoots(tree!);
  const clf = new RulesClassifier(tax);
  const assignments = new Map<string, Assignment>();
  for (const b of flat.bookmarks) assignments.set(b.id, clf.classify({ id: b.id, title: b.title, url: b.url, folderPath: b.path }, 0));
  return buildOrganizePlan({ tree: tree!, flat, taxonomy: tax, assignments, folderMap, now: 0, id: 'plan1', settings: { destinationRootId: roots.other!, rootFolderName: 'LinkSpruce', includeBands: ['high', 'medium'], scopeFolderIds: [], protectedFolderIds: [], skipAlreadyOrganized: true, ...settings } });
}

describe('organize plan → journal → undo', () => {
  it('moves confident items under a LinkSpruce folder and leaves weak ones in place', async () => {
    const { bm, journal, tax } = await setup();
    const p = await plan(bm, tax);
    expect(p.moves.length).toBeGreaterThan(3);
    const titles = p.moves.map((m) => m.title);
    expect(titles).not.toContain('Home'); // weak title stays put
    const steps = planToSteps(p);
    const h = await journal.begin('organize', 'Organize', steps, { source: 'user' });
    const done = await journal.run(h.id);
    expect(done.status).toBe('applied');
    const [tree] = await bm.getTree();
    const flat = flattenTree(tree!);
    const moved = flat.bookmarks.find((b) => b.title.startsWith('Orbital mechanics'))!;
    expect(moved.path.slice(1)).toEqual(['LinkSpruce', 'Astronomy & Space Science', 'Celestial Mechanics']);
    expect(flat.bookmarks.find((b) => b.title === 'Home')!.path).toEqual(['Other bookmarks', 'Old', 'RE']);
    expect(flat.bookmarks.find((b) => b.title.startsWith('Daily horoscope'))!.path.slice(-1)[0]).toBe('Astrology & Esoteric');
    // Original folders remain even if empty.
    expect(flat.folders.some((f) => f.title === 'Python')).toBe(true);
  });

  it('re-applying reuses generated folders and creates no duplicate tree', async () => {
    const { bm, journal, tax } = await setup();
    const p1 = await plan(bm, tax);
    const s1 = planToSteps(p1);
    const h1 = await journal.run((await journal.begin('organize', 'o1', s1, { source: 'user' })).id);
    const states = await journal.states(h1);
    const fm = new Map(folderMapFromResults(p1, s1, states.map((s) => s.rid)).map((e) => [e.categoryId, e]));
    const before = bm.count().folders;
    // New bookmark arrives in an old folder, plan again.
    await bm.create({ parentId: await bm.ensurePath(['Old', 'Astro']), title: 'Kepler orbit determination notes', url: 'https://orbits.example/kepler' });
    const p2 = await plan(bm, tax, fm);
    expect(p2.moves.map((m) => m.title)).toEqual(['Kepler orbit determination notes']);
    expect(p2.folders.every((f) => f.existingId)).toBe(true);
    await journal.run((await journal.begin('organize', 'o2', planToSteps(p2), { source: 'user' })).id);
    expect(bm.count().folders).toBe(before);
    // Even without the folder map, name-based reuse prevents duplicates.
    const p3 = await plan(bm, tax);
    expect(p3.moves).toHaveLength(0);
  });

  it('records conflicts instead of overwriting concurrent user changes', async () => {
    const { bm, journal, tax } = await setup();
    const p = await plan(bm, tax);
    const victim = p.moves[p.moves.length - 1]!;
    const userFolder = await bm.ensurePath(['Mine']);
    await bm.move(victim.bookmarkId, { parentId: userFolder }); // user moves it after preview
    const h = await journal.run((await journal.begin('organize', 'o', planToSteps(p), { source: 'user' })).id);
    expect(h.status).toBe('partial');
    expect(h.counts.conflict).toBe(1);
    const [n] = await bm.get(victim.bookmarkId);
    expect(n!.parentId).toBe(userFolder);
  });

  it('undo restores parents/positions and removes only empty generated folders', async () => {
    const { bm, journal, tax } = await setup();
    const [t0] = await bm.getTree();
    const before = flattenTree(t0!).bookmarks.map((b) => `${b.id}@${b.parentId}#${b.index}`).sort();
    const p = await plan(bm, tax);
    const h = await journal.run((await journal.begin('organize', 'o', planToSteps(p), { source: 'user' })).id);
    // User adds their own bookmark into a generated folder afterwards.
    const [tMid] = await bm.getTree();
    const gen = flattenTree(tMid!).folders.find((f) => f.title === 'Mathematics')!;
    await bm.create({ parentId: gen.id, title: 'My own note', url: 'https://notes.example/' });
    const u = await journal.undo(h.id);
    expect(u.status).toBe('partial'); // Mathematics + LinkSpruce root kept because not empty
    const [t1] = await bm.getTree();
    const flat1 = flattenTree(t1!);
    const after = flat1.bookmarks.filter((b) => b.title !== 'My own note').map((b) => `${b.id}@${b.parentId}#${b.index}`).sort();
    expect(after).toEqual(before);
    expect(flat1.folders.some((f) => f.title === 'Mathematics')).toBe(true);
    expect(flat1.folders.some((f) => f.title === 'Celestial Mechanics')).toBe(false);
    await expect(journal.undo(h.id)).rejects.toThrow(/already undone/);
  });

  it('reconciles a crash between the API call and journal completion without duplicating', async () => {
    const { bm, store, clock, journal, tax } = await setup();
    const p = await plan(bm, tax);
    const steps = planToSteps(p);
    const h = await journal.begin('organize', 'o', steps, { source: 'user' });
    let calls = 0;
    journal.afterApiCall = () => {
      calls++;
      // Freeze the "worker" right after the first create succeeds (simulated termination).
      if (calls === 1) return new Promise<void>(() => undefined);
    };
    void journal.run(h.id);
    await new Promise((r) => setTimeout(r, 30));
    const foldersAfterCrash = bm.count().folders;
    // A fresh worker recovers from the persisted journal.
    const fresh = new Journal(store, bm, clock);
    const reports = await fresh.recover();
    expect(reports[0]!.reconciled).toBeGreaterThan(0);
    const final = await fresh.header(h.id);
    expect(final!.status).toBe('applied');
    const [tree] = await bm.getTree();
    const roots = flattenTree(tree!).folders.filter((f) => f.title === 'LinkSpruce');
    expect(roots).toHaveLength(1);
    expect(bm.count().folders).toBe(foldersAfterCrash + p.folders.filter((f) => !f.existingId).length);
  });

  it('refuses to start when the journal cannot be persisted', async () => {
    const { bm, store, journal, tax } = await setup();
    const p = await plan(bm, tax);
    store.failNextSet = new Error('QUOTA_BYTES quota exceeded');
    const countBefore = JSON.stringify(await bm.getTree());
    await expect(journal.begin('organize', 'o', planToSteps(p), { source: 'user' })).rejects.toThrow(/no changes were made/);
    expect(JSON.stringify(await bm.getTree())).toBe(countBefore);
  });

  it('never touches managed bookmarks and recognizes its own events', async () => {
    const { bm, journal, tax } = await setup();
    const p = await plan(bm, tax);
    expect(p.skipped.managed).toBe(1);
    const created: string[] = [];
    const own: boolean[] = [];
    bm.onCreated.addListener((id, n) => created.push(`${id}|${n.parentId}|${n.title}`));
    await journal.run((await journal.begin('organize', 'o', planToSteps(p), { source: 'user' })).id);
    for (const c of created) {
      const [id, parentId, title] = c.split('|');
      own.push(await journal.isOwnEvent({ kind: 'created', id: id!, parentId, title, url: undefined }));
    }
    expect(own.every(Boolean)).toBe(true);
    expect(await journal.isOwnEvent({ kind: 'created', id: '99999', parentId: '2', title: 'user', url: 'https://u.example/' })).toBe(false);
  });

  it('snapshot capture verifies by read-back and aborts on storage failure', async () => {
    const { bm, store, clock } = await setup();
    const snaps = new SnapshotStore(store, clock, { maxSnapshots: 2, maxTotalBytes: 1e9 });
    const m = await snaps.capture(bm, 'test');
    expect(m.bookmarks).toBe(11);
    store.failSetWhen = (items) => Object.keys(items).some((k) => k.startsWith('snapshot:') && k.endsWith(':meta'));
    await expect(snaps.capture(bm, 'fail')).rejects.toThrow(/could not be saved/);
    store.failSetWhen = null;
    await snaps.capture(bm, 'b');
    await snaps.capture(bm, 'c');
    expect((await snaps.list()).length).toBe(2); // retention
  });
});

describe('undo ordering', () => {
  it('restores the exact original order when several items left one folder', async () => {
    const bm = new FakeBookmarks();
    const store = new FakeStore();
    const journal = new Journal(store, bm, new ManualClock());
    const folder = await bm.ensurePath(['F']);
    const dest = await bm.ensurePath(['D']);
    const ids: string[] = [];
    for (const t of ['A', 'B', 'C', 'D', 'E', 'G']) ids.push((await bm.create({ parentId: folder, title: t, url: `https://x.example/${t}` })).id);
    const order = async () => (await bm.getChildren(folder)).map((c) => c.title).join('');
    expect(await order()).toBe('ABCDEG');
    // Move B, D, E and G away (in an arbitrary order).
    const steps = [ids[3]!, ids[1]!, ids[5]!, ids[4]!].map((id) => ({ op: 'move' as const, id, to: { id: dest }, expect: { parentId: folder } }));
    const h = await journal.run((await journal.begin('organize', 'o', steps, { source: 'user' })).id);
    expect(await order()).toBe('AC');
    const u = await journal.undo(h.id);
    expect(u.status).toBe('applied');
    expect(await order()).toBe('ABCDEG');
  });
});
