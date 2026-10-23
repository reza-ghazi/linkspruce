import { describe, expect, it } from 'vitest';
import { chooseKeeper, defaultRemovalSelection, findDuplicates, type LinkSignals } from '../../src/core/duplicates.ts';
import type { FlatBookmark } from '../../src/core/tree.ts';

let n = 0;
const bm = (url: string, extra: Partial<FlatBookmark> = {}): FlatBookmark => {
  n++;
  return { id: `b${n}`, parentId: 'f1', index: n, title: `T${n}`, url, dateAdded: 1000 * n, path: ['A'], pathIds: ['f1'], depth: 1, writable: true, ...extra };
};

describe('findDuplicates', () => {
  it('groups identical URLs regardless of title', () => {
    const a = bm('https://x.com/a', { title: 'One' });
    const b = bm('https://x.com/a', { title: 'Completely different' });
    const r = findDuplicates([a, b]);
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0]!.evidence[0]!.kind).toBe('identical');
  });
  it('does not treat same-title different-URL bookmarks as duplicates', () => {
    expect(findDuplicates([bm('https://x.com/a', { title: 'Same' }), bm('https://x.com/b', { title: 'Same' })]).groups).toHaveLength(0);
  });
  it('separates normalized and tracking evidence', () => {
    const r = findDuplicates([bm('HTTPS://X.com:443/p'), bm('https://x.com/p'), bm('https://x.com/p?utm_source=nl&utm_medium=email')]);
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0]!.evidence.map((e) => e.kind).sort()).toEqual(['normalized', 'tracking']);
  });
  it('keeps distinct: protocol, www, trailing slash, hash routes, anchors, meaningful params', () => {
    const r = findDuplicates([
      bm('http://x.com/p'), bm('https://x.com/p'), bm('https://www.x.com/p'), bm('https://x.com/p/'),
      bm('https://app.com/#/a'), bm('https://app.com/#/b'), bm('https://d.com/doc#install'), bm('https://d.com/doc#usage'),
      bm('https://s.com/?page=1'), bm('https://s.com/?page=2'), bm('https://s.com/?ref=a'), bm('https://s.com/?ref=b'),
    ]);
    expect(r.groups).toHaveLength(0);
  });
  it('turns matching redirect destinations into suggestions, not groups', () => {
    const a = bm('http://old.x.com/article-1');
    const b = bm('https://x.com/article-1');
    const signals = new Map<string, LinkSignals>([[a.id, { finalUrl: 'https://x.com/article-1', redirected: true }]]);
    const r = findDuplicates([a, b], signals);
    expect(r.groups).toHaveLength(0);
    expect(r.suggestions).toHaveLength(1);
    expect(r.suggestions[0]!.evidence[0]!.kind).toBe('redirect');
  });
  it('never merges bookmarks that converge on a shared login/home page', () => {
    const list = [bm('https://a.com/private/1'), bm('https://a.com/private/2'), bm('https://a.com/private/3')];
    const signals = new Map<string, LinkSignals>(list.map((b) => [b.id, { finalUrl: 'https://a.com/login?next=x', redirected: true }]));
    const r = findDuplicates(list, signals);
    expect(r.suggestions).toHaveLength(0);
    expect(r.convergentDestinations[0]!.reason).toMatch(/login/);
    const home = [bm('https://b.com/x'), bm('https://b.com/y')];
    const r2 = findDuplicates(home, new Map(home.map((b) => [b.id, { finalUrl: 'https://b.com/' }])));
    expect(r2.suggestions).toHaveLength(0);
  });
  it('does not let a weak canonical edge transitively merge a cluster', () => {
    const list = [bm('https://c.com/a'), bm('https://c.com/b'), bm('https://c.com/c')];
    const sig = new Map<string, LinkSignals>([
      [list[0]!.id, { canonical: 'https://c.com/b' }],
      [list[2]!.id, { canonical: 'https://c.com/b?x=1' }],
    ]);
    const r = findDuplicates(list, sig);
    expect(r.groups).toHaveLength(0);
    // a↔b suggested; c's canonical differs, so c is not pulled in via b.
    expect(r.suggestions.map((s) => [...s.a, ...s.b].sort())).toEqual([[list[0]!.id, list[1]!.id].sort()]);
  });
  it('ignores overbroad root canonicals and cross-site canonicals', () => {
    const list = [bm('https://d.com/post/1'), bm('https://d.com/post/2'), bm('https://e.com/x'), bm('https://f.com/y')];
    const sig = new Map<string, LinkSignals>([
      [list[0]!.id, { canonical: 'https://d.com/' }],
      [list[1]!.id, { canonical: 'https://d.com/' }],
      [list[2]!.id, { canonical: 'https://spam.com/z' }],
      [list[3]!.id, { canonical: 'https://spam.com/z' }],
    ]);
    expect(findDuplicates(list, sig).suggestions).toHaveLength(0);
  });
});

describe('keeper selection', () => {
  it('supports oldest/newest/shallowest/manual and preselects only same-folder copies', () => {
    const a = bm('https://k.com/', { dateAdded: 5, depth: 3 });
    const b = bm('https://k.com/', { dateAdded: 1, depth: 2 });
    const c = bm('https://k.com/', { dateAdded: 9, depth: 1 });
    expect(chooseKeeper([a, b, c], 'oldest')).toBe(b.id);
    expect(chooseKeeper([a, b, c], 'newest')).toBe(c.id);
    expect(chooseKeeper([a, b, c], 'shallowest')).toBe(c.id);
    expect(chooseKeeper([a, b, c], 'manual', a.id)).toBe(a.id);
    const g = findDuplicates([a, b, c]).groups[0]!;
    expect(defaultRemovalSelection(g, [a, b, c], 'oldest').sort()).toEqual([a.id, c.id].sort());
    const d = bm('https://m.com/', { parentId: 'f2' });
    const e = bm('https://m.com/', { parentId: 'f3' });
    const g2 = findDuplicates([d, e]).groups[0]!;
    expect(defaultRemovalSelection(g2, [d, e], 'oldest')).toEqual([]);
  });
});
