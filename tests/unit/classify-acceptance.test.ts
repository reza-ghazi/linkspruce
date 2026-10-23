/**
 * Synthetic multilingual acceptance cases for the offline baseline and the
 * taxonomy machinery (brief §6A). Not derived from any private data.
 */
import { describe, expect, it } from 'vitest';
import { RulesClassifier } from '../../src/core/classify/classifier.ts';
import type { ItemInput } from '../../src/core/classify/features.ts';
import { resolveAssignment, suggestRules, type UserRule } from '../../src/core/classify/precedence.ts';
import { consistencyPass, inventory, offlineDraft, parseUserTaxonomy, stratifiedSample, taxonomyFromFolders } from '../../src/core/discovery/discovery.ts';
import { freeze } from '../../src/core/taxonomy/taxonomy.ts';
import { testTaxonomy } from '../helpers/fixtures.ts';

const T = testTaxonomy();
const clf = new RulesClassifier(T);
const cls = (title: string, url: string, folderPath: string[] = []) => clf.classify({ id: 'x', title, url, folderPath }, 0);

describe('semantic distinctions', () => {
  it('same subject on different domains shares a category', () => {
    expect(cls('Two-body problem in celestial mechanics', 'https://uni-a.example.edu/cm').categoryId).toBe('cat_celmech');
    expect(cls('Orbital mechanics lecture: Kepler orbits', 'https://blog-b.example.com/kepler').categoryId).toBe('cat_celmech');
  });
  it('different subjects on one platform domain are separated', () => {
    expect(cls('poliastro: astrodynamics and orbital mechanics in Python', 'https://github.com/poliastro/poliastro').categoryId).toBe('cat_celmech');
    expect(cls('Python tutorial for beginners', 'https://github.com/someone/python-tutorial').categoryId).toBe('cat_proglang');
    expect(cls('Number theory: primes', 'https://www.youtube.com/watch?v=abc').categoryId).toBe('cat_numtheory');
  });
  it('English and Persian resources on one subject are colocated', () => {
    expect(cls('Lunar crescent visibility criteria', 'https://a.example/hilal').categoryId).toBe('cat_crescent');
    expect(cls('رؤیت هلال ماه شوال', 'https://b.example.ir/x').categoryId).toBe('cat_crescent');
    expect(cls('تبدیل تاریخ هجری شمسی به میلادی', 'https://c.example.ir/').categoryId).toBe('cat_calconv');
  });
  it('astronomy vs astrology and occultation vs occultism', () => {
    expect(cls('Daily horoscope and zodiac signs', 'https://h.example/').categoryId).toBe('cat_esoteric');
    expect(cls('Lunar occultation timings for observers', 'https://o.example/').categoryId).not.toBe('cat_esoteric');
    expect(cls('Occultism and hermetic traditions', 'https://e.example/').categoryId).toBe('cat_esoteric');
  });
  it('old folders cannot override strong contrary content evidence', () => {
    const a = cls('Celestial mechanics: orbital perturbation theory', 'https://cm.example/', ['Real Estate', 'Listings']);
    expect(a.categoryId).toBe('cat_celmech');
    const folderOnly = cls('Untitled document', 'https://docs.example/d', ['Number Theory']);
    expect(folderOnly.band === 'low' || folderOnly.categoryId === null).toBe(true);
    if (folderOnly.categoryId) expect(folderOnly.rationale).toMatch(/folder/i);
  });
  it('weak titles abstain unless the domain is subject-specific, and say so', () => {
    expect(cls('Home', 'https://random.example/').categoryId).toBeNull();
    const d = cls('Login', 'https://ssd.jpl.nasa.gov/horizons/');
    expect(d.categoryId).not.toBeNull();
    expect(d.rationale).toMatch(/domain/i);
  });
  it('facets stay separate from folders (resource type, language)', () => {
    const a = cls('Number theory preprint on prime gaps', 'https://math.example.edu/nt/preprint.pdf');
    expect(a.categoryId).toBe('cat_numtheory');
    expect(a.facets.resourceType).toBe('paper');
    expect(cls('رؤیت هلال', 'https://x.example.ir').facets.language).toBe('fa');
  });
});

describe('precedence and learning', () => {
  const item = { id: 'b', title: 'Celestial mechanics notes', url: 'https://cm.example/', folderPath: ['A'], pathIds: ['f1'] };
  const base = { taxonomy: T, protectedFolderIds: new Set<string>(), excludedBookmarkIds: new Set<string>(), overrides: new Map(), rules: [] as UserRule[], classify: (x: ItemInput) => clf.classify(x, 0), now: 0 };
  it('protected > user assignment > user rule > classification', () => {
    expect(resolveAssignment(item, { ...base, protectedFolderIds: new Set(['f1']) }).provider).toBe('protected');
    expect(resolveAssignment(item, { ...base, overrides: new Map([['b', { categoryId: 'cat_math', at: 0, reason: 'manual-assign' as const }]]) }).categoryId).toBe('cat_math');
    const rule: UserRule = { id: 'r', kind: 'domain', pattern: 'cm.example', categoryId: 'cat_realestate', approved: true, createdAt: 0, source: 'user' };
    expect(resolveAssignment(item, { ...base, rules: [rule] }).categoryId).toBe('cat_realestate');
    expect(resolveAssignment(item, { ...base, rules: [{ ...rule, approved: false }] }).categoryId).toBe('cat_celmech');
    expect(resolveAssignment(item, base).categoryId).toBe('cat_celmech');
  });
  it('one correction never becomes a sweeping rule; repeated consistent ones only suggest one', () => {
    expect(suggestRules([{ bookmarkId: '1', site: 'x.com', fromCategoryId: null, toCategoryId: 'cat_math', at: 0 }], [])).toEqual([]);
    const three = [1, 2, 3].map((i) => ({ bookmarkId: String(i), site: 'x.com', fromCategoryId: null, toCategoryId: 'cat_math', at: i }));
    expect(suggestRules(three, [])).toEqual([{ kind: 'domain', pattern: 'x.com', categoryId: 'cat_math', approved: false, source: 'suggested' }]);
    expect(suggestRules([...three, { bookmarkId: '4', site: 'x.com', fromCategoryId: null, toCategoryId: 'cat_astronomy', at: 4 }], [])).toEqual([]);
  });
  it('stale stored assignments are recomputed after title edits or breaking taxonomy changes', () => {
    const stored = { ...clf.classify(item, 0), categoryId: 'cat_math', provider: 'gemini' as const };
    expect(resolveAssignment(item, { ...base, stored }).categoryId).toBe('cat_math');
    expect(resolveAssignment({ ...item, title: 'Real estate exam' }, { ...base, stored }).categoryId).not.toBe('cat_math');
    const t2 = freeze(T, 1);
    expect(resolveAssignment(item, { ...base, taxonomy: t2, stored }).categoryId).toBe('cat_celmech');
  });
});

describe('discovery helpers', () => {
  const items = [
    ...Array.from({ length: 60 }, (_, i) => ({ id: `a${i}`, title: `Celestial mechanics orbit notes ${i}`, url: `https://big.example/${i}`, folderPath: ['Space'] })),
    ...Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, title: `رؤیت هلال ${i}`, url: `https://fa${i}.example.ir/`, folderPath: [] })),
    ...Array.from({ length: 4 }, (_, i) => ({ id: `w${i}`, title: 'Home', url: `https://w${i}.example/`, folderPath: [] })),
    ...Array.from({ length: 5 }, (_, i) => ({ id: `d${i}`, title: 'Duplicate link', url: 'https://same.example/', folderPath: [] })),
  ];
  const inv = inventory(items);
  it('inventory counts languages, weak titles and repeated URLs; repeats do not dominate', () => {
    expect(inv.total).toBe(75);
    expect(inv.languages.fa).toBe(6);
    expect(inv.weakTitles).toBe(4);
    expect(inv.repeatedUrlInstances).toBe(4);
  });
  it('stratified sampling covers small subjects, minority languages and weak titles, not just the first N', () => {
    const s = stratifiedSample(items, inv, { size: 20, seed: 1, minPerStratum: 2 });
    expect(s.some((x) => x.id.startsWith('p'))).toBe(true);
    expect(s.some((x) => x.id.startsWith('w'))).toBe(true);
    expect(s.filter((x) => x.id.startsWith('a')).length).toBeLessThan(15);
    expect(new Set(s.map((x) => x.url)).size).toBe(s.length);
    expect(stratifiedSample(items, inv, { size: 20, seed: 1, minPerStratum: 2 }).map((x) => x.id)).toEqual(s.map((x) => x.id));
  });
  it('offline draft adapts to the collection and is labelled as offline', () => {
    const d = offlineDraft(inv, 't', 0, 'detailed');
    expect(d.taxonomy.categories.some((c) => c.name === 'Astronomy & Space Science')).toBe(true);
    expect(d.taxonomy.categories.some((c) => c.name === 'Real Estate')).toBe(false);
    expect(d.notes.join(' ')).toMatch(/Offline draft/);
  });
  it('parses a user taxonomy with aliases and builds one from folders', () => {
    const t = parseUserTaxonomy('Astronomy\n  Celestial Mechanics | orbits, astrodynamics\nReal Estate\n', 'u', 0);
    expect(t.categories.map((c) => c.name)).toEqual(['Astronomy', 'Celestial Mechanics', 'Real Estate']);
    expect(t.categories[1]!.aliases).toEqual(['orbits', 'astrodynamics']);
    const f = taxonomyFromFolders([{ id: '1', title: 'Bookmarks bar', path: [], bookmarkIds: [] }, { id: '2', title: 'Astro', path: ['Bookmarks bar'], bookmarkIds: Array.from({ length: 20 }, (_, i) => `x${i}`) }, { id: '3', title: 'Misc', path: ['Bookmarks bar'], bookmarkIds: Array.from({ length: 20 }, (_, i) => `y${i}`) }], 'f', 0);
    expect(f.categories.map((c) => c.name)).toEqual(['Astro']);
  });
  it('consistency pass flags overlapping siblings, platform and format categories', () => {
    const t = parseUserTaxonomy('Machine Learning\nML | machine learning\nYouTube\nVideos\n', 'c', 0);
    const issues = consistencyPass(t, new Map(), 0).map((i) => i.kind);
    expect(issues).toEqual(expect.arrayContaining(['overlapping-siblings', 'platform-category', 'mixed-principle']));
  });
});
