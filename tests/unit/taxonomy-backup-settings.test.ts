import { describe, expect, it } from 'vitest';
import { makeBackupFile, validateRestoreFile, countSnap } from '../../src/core/backup.ts';
import { migrateSettings, updateSettings, defaultSettings } from '../../src/core/settings.ts';
import { addAutoCategory, applyEdit, assignmentCurrent, emptyTaxonomy, findEquivalent, freeze, sanitizeCategoryName, TaxonomyError } from '../../src/core/taxonomy/taxonomy.ts';
import { testTaxonomy } from '../helpers/fixtures.ts';

describe('taxonomy editing and versioning', () => {
  it('rename keeps ids and assignments; merge/reparent are breaking', () => {
    const t = testTaxonomy();
    const r = applyEdit(t, { op: 'rename', id: 'cat_math', name: 'Maths' }, 2);
    expect(r.categories.find((c) => c.id === 'cat_math')!.aliases).toContain('Mathematics');
    expect(assignmentCurrent(r, t.version, 'cat_math')).toBe(true);
    const m = applyEdit(r, { op: 'merge', sourceIds: ['cat_observing'], targetId: 'cat_celmech' }, 3);
    expect(m.categories.some((c) => c.id === 'cat_observing')).toBe(false);
    expect(assignmentCurrent(m, r.version, 'cat_celmech')).toBe(false);
    expect(m.categories.find((c) => c.id === 'cat_celmech')!.aliases).toContain('Observational Astronomy');
    expect(() => applyEdit(m, { op: 'reparent', id: 'cat_astronomy', parentId: 'cat_celmech' }, 4)).toThrow(TaxonomyError);
    const sp = applyEdit(m, { op: 'split', id: 'cat_math', children: [{ name: 'Algebra', parentId: 'cat_math' }, { name: 'Analysis', parentId: 'cat_math' }] }, 5);
    expect(sp.categories.filter((c) => c.parentId === 'cat_math').map((c) => c.name)).toEqual(['Number Theory', 'Algebra', 'Analysis']);
    const rej = applyEdit(sp, { op: 'reject', id: 'cat_realestate' }, 6);
    expect(assignmentCurrent(rej, rej.version, 'cat_realestate')).toBe(false);
  });
  it('rejects duplicate siblings, URLs and empty names; never reuses retired ids', () => {
    const t = testTaxonomy();
    expect(() => applyEdit(t, { op: 'add', input: { name: 'mathematics', parentId: null } }, 1)).toThrow(/already exists/);
    expect(() => sanitizeCategoryName('https://evil.example')).toThrow();
    expect(() => sanitizeCategoryName('   ')).toThrow();
    expect(() => sanitizeCategoryName('x'.repeat(61))).toThrow();
    const m = applyEdit(t, { op: 'merge', sourceIds: ['cat_observing'], targetId: 'cat_celmech' }, 2);
    // Re-adding a merged name as a sibling is refused (it is now an alias)...
    expect(() => applyEdit(m, { op: 'add', input: { name: 'Observational Astronomy', parentId: 'cat_astronomy' } }, 3)).toThrow(/already exists/);
    // ...and a new category whose slug matches the retired id gets a fresh id.
    const a = applyEdit(m, { op: 'add', input: { name: 'Observing', parentId: 'cat_math' } }, 3);
    expect(a.categories.find((c) => c.name === 'Observing')!.id).toBe('cat_observing_2');
  });
  it('auto-filing additions reuse equivalents and are non-breaking', () => {
    const t = testTaxonomy();
    const same = addAutoCategory(t, { name: 'number theory', parentId: 'cat_math' }, 2);
    expect(same.reused).toBe(true);
    const n = addAutoCategory(t, { name: 'Topology', parentId: 'cat_math' }, 2);
    expect(n.reused).toBe(false);
    expect(n.taxonomy.breakingVersion).toBe(t.breakingVersion);
    expect(n.taxonomy.version).toBe(t.version + 1);
    expect(findEquivalent(n.taxonomy, 'topology')?.id).toBe(n.category.id);
  });
  it('freeze bumps the breaking version', () => {
    const t = emptyTaxonomy('x', 0);
    expect(freeze(t, 1).breakingVersion).toBeGreaterThan(t.breakingVersion);
  });
});

describe('restore validation', () => {
  const root = { title: '', children: [{ title: 'Bar', children: [{ title: 'A', url: 'https://a.example/' }, { title: 'Bad', url: 'javascript:alert(1)' }, { title: 'Data', url: 'data:text/html,x' }] }] };
  it('accepts LinkSpruce JSON, skips script URLs, and counts', () => {
    const file = JSON.stringify(makeBackupFile(root, '1.0.0', new Date(0)));
    const v = validateRestoreFile(file);
    expect(v.ok).toBe(true);
    expect(v.counts).toMatchObject({ bookmarks: 1, folders: 1 });
    expect(v.skippedUrls).toBe(2);
  });
  it('rejects wrong format, future schema, oversize, bad JSON and over-deep trees', () => {
    expect(validateRestoreFile('{"format":"x"}').errors[0]).toMatch(/Not a LinkSpruce/);
    expect(validateRestoreFile(JSON.stringify({ ...makeBackupFile(root, '1', new Date(0)), schemaVersion: 99 })).errors[0]).toMatch(/schema/);
    expect(validateRestoreFile('{nope').errors[0]).toMatch(/JSON/);
    expect(validateRestoreFile('x'.repeat(100), { maxBytes: 10, maxNodes: 10, maxDepth: 5, allowScriptUrls: false }).errors[0]).toMatch(/larger/);
    let deep: { title: string; children: unknown[] } = { title: 'leaf', children: [] };
    for (let i = 0; i < 80; i++) deep = { title: `f${i}`, children: [deep] };
    expect(validateRestoreFile(JSON.stringify(makeBackupFile(deep as never, '1', new Date(0)))).errors[0]).toMatch(/deeper/);
    expect(validateRestoreFile('hello').errors[0]).toMatch(/Unrecognized/);
  });
  it('accepts bookmarks HTML exports', () => {
    const v = validateRestoreFile('<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><p><DT><H3>F</H3><DL><p><DT><A HREF="https://x.example/">X</A></DL></DL>');
    expect(v).toMatchObject({ ok: true, source: 'netscape-html' });
    expect(countSnap(v.root!).bookmarks).toBe(1);
  });
});

describe('settings', () => {
  it('fills defaults, drops unknown keys and clamps unsafe values', () => {
    const s = migrateSettings({ audit: { maxConcurrent: 50, timeoutMs: 120000 }, bogus: 1, protectedFolderIds: ['ok', '<script>'] });
    expect(s.audit.maxConcurrent).toBe(5);
    expect(s.audit.timeoutMs).toBe(25000);
    expect((s as unknown as Record<string, unknown>).bogus).toBeUndefined();
    expect(s.protectedFolderIds).toEqual(['ok']);
    const u = updateSettings(defaultSettings(), { autoFile: { settleSeconds: 0 }, includeBands: ['nope'] });
    expect(u.autoFile.settleSeconds).toBe(2);
    expect(u.includeBands).toEqual(['high']);
  });
});
