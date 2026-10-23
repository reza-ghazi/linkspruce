/**
 * Versioned taxonomy with stable category ids.
 *
 * - `version` increments on every change.
 * - `breakingVersion` is the version of the last change that can alter
 *   existing assignments (rename does not; merge/split/reparent/reject do).
 *   Assignments made before it are stale and must be reclassified.
 * - Additive changes (auto-filing creating a category) bump `version` only,
 *   which invalidates bulk plans (they fingerprint `version`) but keeps
 *   existing assignments valid.
 * Category ids are never reused, so renames keep assignments intact.
 */
import { foldText, jaccard, slugify, tokenize } from '../text.ts';

export const TAXONOMY_SCHEMA = 1;

export type CategoryStatus = 'active' | 'rejected' | 'excluded';
export type CategoryOrigin = 'discovered' | 'user' | 'auto-created' | 'imported';

export interface Category {
  id: string;
  name: string;
  nameFa?: string | undefined;
  parentId: string | null;
  definition: string;
  include: string[];
  exclude: string[];
  aliases: string[];
  examples: string[];
  /** Lexicon concept keys that feed the offline classifier. */
  conceptKeys: string[];
  status: CategoryStatus;
  origin: CategoryOrigin;
  pinned?: boolean | undefined;
  estimatedCount?: number | undefined;
  /** True when estimatedCount comes from a sample. */
  estimate?: boolean | undefined;
  createdAt: number;
  createdInVersion: number;
  rationale?: string | undefined;
}

export type GranularityPreset = 'compact' | 'balanced' | 'detailed';

export interface Granularity {
  preset: GranularityPreset;
  topMin: number;
  topMax: number;
  maxDepth: number;
  /** Minimum estimated members for a discovered leaf to stand alone. */
  minLeaf: number;
  /** Leaves above this size are candidates for splitting. */
  splitAbove: number;
}

export const GRANULARITY: Record<GranularityPreset, Granularity> = {
  compact: { preset: 'compact', topMin: 6, topMax: 10, maxDepth: 2, minLeaf: 40, splitAbove: 1500 },
  balanced: { preset: 'balanced', topMin: 10, topMax: 16, maxDepth: 4, minLeaf: 12, splitAbove: 600 },
  detailed: { preset: 'detailed', topMin: 12, topMax: 24, maxDepth: 5, minLeaf: 5, splitAbove: 250 },
};

export type TaxonomyMode = 'discover' | 'improve' | 'user';
export type LabelLanguage = 'en' | 'fa' | 'bilingual';

export interface Taxonomy {
  schema: number;
  id: string;
  version: number;
  breakingVersion: number;
  frozen: boolean;
  mode: TaxonomyMode;
  labelLanguage: LabelLanguage;
  granularity: Granularity;
  categories: Category[];
  createdAt: number;
  updatedAt: number;
  /** Provider that produced the draft (rules, chrome-ai, gemini). */
  discoveredBy?: string | undefined;
  notes?: string[] | undefined;
}

export const MAX_NAME_LENGTH = 60;
export const MAX_CATEGORIES = 600;

export class TaxonomyError extends Error {}

export function emptyTaxonomy(id: string, now: number, mode: TaxonomyMode = 'discover', preset: GranularityPreset = 'balanced'): Taxonomy {
  return {
    schema: TAXONOMY_SCHEMA,
    id,
    version: 1,
    breakingVersion: 1,
    frozen: false,
    mode,
    labelLanguage: 'en',
    granularity: { ...GRANULARITY[preset] },
    categories: [],
    createdAt: now,
    updatedAt: now,
  };
}

/** Validate and clean a category name. Rejects control chars, URLs and overlong names. */
export function sanitizeCategoryName(raw: unknown): string {
  if (typeof raw !== 'string') throw new TaxonomyError('Category name must be text');
   
  const s = raw.normalize('NFC').replace(/[\u0000-\u001f\u007f‎‏‪-‮⁦-⁩]/g, '').replace(/\s+/g, ' ').trim();
  if (!s) throw new TaxonomyError('Category name is empty');
  if (s.length > MAX_NAME_LENGTH) throw new TaxonomyError(`Category name longer than ${MAX_NAME_LENGTH} characters`);
  if (/https?:\/\/|www\./i.test(s)) throw new TaxonomyError('Category name cannot be a URL');
  if (/^[\p{P}\p{S}\s\d]+$/u.test(s)) throw new TaxonomyError('Category name needs letters');
  return s;
}

function clone(t: Taxonomy): Taxonomy {
  return JSON.parse(JSON.stringify(t)) as Taxonomy;
}

export function byId(t: Taxonomy): Map<string, Category> {
  return new Map(t.categories.map((c) => [c.id, c]));
}

export function activeCategories(t: Taxonomy): Category[] {
  const map = byId(t);
  return t.categories.filter((c) => {
    for (let x: Category | undefined = c; x; x = x.parentId ? map.get(x.parentId) : undefined) {
      if (x.status !== 'active') return false;
    }
    return true;
  });
}

export function childrenOf(t: Taxonomy, parentId: string | null): Category[] {
  return t.categories.filter((c) => c.parentId === parentId);
}

export function pathOf(t: Taxonomy, id: string): Category[] {
  const map = byId(t);
  const out: Category[] = [];
  const seen = new Set<string>();
  for (let c = map.get(id); c; c = c.parentId ? map.get(c.parentId) : undefined) {
    if (seen.has(c.id)) throw new TaxonomyError('Cycle in taxonomy');
    seen.add(c.id);
    out.unshift(c);
  }
  return out;
}

export function pathLabel(t: Taxonomy, id: string, sep = ' › '): string {
  return pathOf(t, id)
    .map((c) => displayName(t, c))
    .join(sep);
}

export function displayName(t: Taxonomy, c: Category): string {
  if (t.labelLanguage === 'fa' && c.nameFa) return c.nameFa;
  if (t.labelLanguage === 'bilingual' && c.nameFa) return `${c.name} / ${c.nameFa}`;
  return c.name;
}

export function depthOf(t: Taxonomy, id: string): number {
  return pathOf(t, id).length;
}

export function isDescendant(t: Taxonomy, id: string, ancestorId: string): boolean {
  return pathOf(t, id).some((c) => c.id === ancestorId && c.id !== id);
}

/** Generate a stable, unused category id from a name. */
export function newCategoryId(t: Taxonomy, name: string, usedIds: ReadonlySet<string> = new Set()): string {
  const base = `cat_${slugify(name)}`;
  const taken = new Set([...t.categories.map((c) => c.id), ...usedIds, ...(t.notes ?? []).filter((n) => n.startsWith('retired:')).map((n) => n.slice(8))]);
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}_${i}`)) return `${base}_${i}`;
}

/** Find an existing category equivalent to a name (case/diacritic-insensitive, aliases, token overlap). */
export function findEquivalent(t: Taxonomy, name: string, parentId?: string | null, opts: { fuzzy?: boolean } = { fuzzy: true }): Category | undefined {
  const f = foldText(name);
  const candidates = activeCategories(t).filter((c) => parentId === undefined || c.parentId === parentId);
  for (const c of candidates) {
    if (foldText(c.name) === f || (c.nameFa && foldText(c.nameFa) === f) || c.aliases.some((a) => foldText(a) === f)) return c;
  }
  if (!opts.fuzzy) return undefined;
  const toks = tokenize(name);
  if (toks.length === 0) return undefined;
  let best: { c: Category; s: number } | undefined;
  for (const c of candidates) {
    const s = Math.max(jaccard(toks, tokenize(c.name)), ...c.aliases.map((a) => jaccard(toks, tokenize(a))));
    if (s >= 0.75 && (!best || s > best.s)) best = { c, s };
  }
  return best?.c;
}

export interface NewCategoryInput {
  name: string;
  nameFa?: string | undefined;
  parentId: string | null;
  definition?: string | undefined;
  include?: string[] | undefined;
  exclude?: string[] | undefined;
  aliases?: string[] | undefined;
  examples?: string[] | undefined;
  conceptKeys?: string[] | undefined;
  origin?: CategoryOrigin | undefined;
  estimatedCount?: number | undefined;
  estimate?: boolean | undefined;
  rationale?: string | undefined;
  id?: string | undefined;
}

function cleanList(v: string[] | undefined, max = 12, len = 120): string[] {
  return (v ?? [])
    .filter((x): x is string => typeof x === 'string')
    .map((x) => x.replace(/\s+/g, ' ').trim().slice(0, len))
    .filter(Boolean)
    .slice(0, max);
}

function makeCategory(t: Taxonomy, input: NewCategoryInput, now: number): Category {
  const name = sanitizeCategoryName(input.name);
  if (input.parentId !== null && !t.categories.some((c) => c.id === input.parentId)) {
    throw new TaxonomyError(`Unknown parent ${input.parentId}`);
  }
  const depth = input.parentId === null ? 1 : depthOf(t, input.parentId) + 1;
  if (depth > t.granularity.maxDepth + 1) throw new TaxonomyError(`Depth ${depth} exceeds limit`);
  if (t.categories.length >= MAX_CATEGORIES) throw new TaxonomyError('Too many categories');
  return {
    id: input.id ?? newCategoryId(t, name),
    name,
    nameFa: input.nameFa ? sanitizeCategoryName(input.nameFa) : undefined,
    parentId: input.parentId,
    definition: (input.definition ?? '').replace(/\s+/g, ' ').trim().slice(0, 400),
    include: cleanList(input.include),
    exclude: cleanList(input.exclude),
    aliases: cleanList(input.aliases, 16, 60),
    examples: cleanList(input.examples, 8),
    conceptKeys: cleanList(input.conceptKeys, 12, 40),
    status: 'active',
    origin: input.origin ?? 'user',
    estimatedCount: input.estimatedCount,
    estimate: input.estimate,
    createdAt: now,
    createdInVersion: t.version + 1,
    rationale: input.rationale?.slice(0, 300),
  };
}

function bump(t: Taxonomy, now: number, breaking: boolean): void {
  t.version++;
  if (breaking) t.breakingVersion = t.version;
  t.updatedAt = now;
}

export type TaxonomyEdit =
  | { op: 'add'; input: NewCategoryInput }
  | { op: 'rename'; id: string; name: string; nameFa?: string | undefined }
  | { op: 'define'; id: string; definition?: string; include?: string[]; exclude?: string[]; aliases?: string[] }
  | { op: 'merge'; sourceIds: string[]; targetId: string }
  | { op: 'split'; id: string; children: NewCategoryInput[] }
  | { op: 'reparent'; id: string; parentId: string | null }
  | { op: 'pin'; id: string; pinned: boolean }
  | { op: 'reject'; id: string }
  | { op: 'exclude'; id: string }
  | { op: 'restore'; id: string };

/**
 * Apply an edit, returning a new taxonomy. Edits to a frozen taxonomy are
 * allowed (they produce a new version); callers decide whether to unfreeze.
 */
export function applyEdit(t0: Taxonomy, edit: TaxonomyEdit, now: number): Taxonomy {
  const t = clone(t0);
  const map = byId(t);
  const need = (id: string) => {
    const c = map.get(id);
    if (!c) throw new TaxonomyError(`Unknown category ${id}`);
    return c;
  };
  switch (edit.op) {
    case 'add': {
      const c = makeCategory(t, edit.input, now);
      const dupe = findEquivalent(t, c.name, c.parentId, { fuzzy: false });
      if (dupe) throw new TaxonomyError(`"${c.name}" already exists under the same parent`);
      t.categories.push(c);
      bump(t, now, false);
      break;
    }
    case 'rename': {
      const c = need(edit.id);
      const name = sanitizeCategoryName(edit.name);
      const dupe = findEquivalent(t, name, c.parentId, { fuzzy: false });
      if (dupe && dupe.id !== c.id) throw new TaxonomyError(`"${name}" already exists under the same parent`);
      if (foldText(c.name) !== foldText(name) && !c.aliases.includes(c.name)) c.aliases.push(c.name);
      c.name = name;
      if (edit.nameFa !== undefined) c.nameFa = edit.nameFa ? sanitizeCategoryName(edit.nameFa) : undefined;
      bump(t, now, false);
      break;
    }
    case 'define': {
      const c = need(edit.id);
      if (edit.definition !== undefined) c.definition = edit.definition.replace(/\s+/g, ' ').trim().slice(0, 400);
      if (edit.include) c.include = cleanList(edit.include);
      if (edit.exclude) c.exclude = cleanList(edit.exclude);
      if (edit.aliases) c.aliases = cleanList(edit.aliases, 16, 60);
      bump(t, now, true);
      break;
    }
    case 'merge': {
      const target = need(edit.targetId);
      for (const sid of edit.sourceIds) {
        if (sid === target.id) continue;
        const src = need(sid);
        if (isDescendant(t, target.id, src.id)) throw new TaxonomyError('Cannot merge a category into its own descendant');
        // Children move to the target; the source becomes a retired alias.
        for (const child of t.categories.filter((c) => c.parentId === src.id)) child.parentId = target.id;
        target.aliases = cleanList([...target.aliases, src.name, ...src.aliases], 32, 60);
        target.conceptKeys = [...new Set([...target.conceptKeys, ...src.conceptKeys])];
        target.examples = cleanList([...target.examples, ...src.examples], 8);
        if (target.estimatedCount !== undefined || src.estimatedCount !== undefined) {
          target.estimatedCount = (target.estimatedCount ?? 0) + (src.estimatedCount ?? 0);
        }
        t.categories = t.categories.filter((c) => c.id !== src.id);
        t.notes = [...(t.notes ?? []), `retired:${src.id}`, `merged:${src.id}->${target.id}`];
      }
      bump(t, now, true);
      break;
    }
    case 'split': {
      const parent = need(edit.id);
      const added: Category[] = [];
      for (const input of edit.children) {
        const tmp = { ...t, categories: [...t.categories, ...added] };
        const c = makeCategory(tmp, { ...input, parentId: parent.id }, now);
        if (findEquivalent(tmp, c.name, parent.id, { fuzzy: false })) throw new TaxonomyError(`"${c.name}" already exists`);
        added.push(c);
      }
      t.categories.push(...added);
      bump(t, now, true);
      break;
    }
    case 'reparent': {
      const c = need(edit.id);
      if (edit.parentId !== null) {
        need(edit.parentId);
        if (edit.parentId === c.id || isDescendant(t, edit.parentId, c.id)) throw new TaxonomyError('Cannot move a category beneath itself');
      }
      c.parentId = edit.parentId;
      const subtreeDepth = (id: string): number => 1 + Math.max(0, ...t.categories.filter((x) => x.parentId === id).map((x) => subtreeDepth(x.id)));
      if ((edit.parentId ? depthOf(t, edit.parentId) : 0) + subtreeDepth(c.id) > t.granularity.maxDepth + 1) {
        throw new TaxonomyError('Move would exceed the depth limit');
      }
      bump(t, now, true);
      break;
    }
    case 'pin':
      need(edit.id).pinned = edit.pinned;
      bump(t, now, false);
      break;
    case 'reject':
      need(edit.id).status = 'rejected';
      bump(t, now, true);
      break;
    case 'exclude':
      need(edit.id).status = 'excluded';
      bump(t, now, true);
      break;
    case 'restore':
      need(edit.id).status = 'active';
      bump(t, now, true);
      break;
  }
  validateTaxonomy(t);
  return t;
}

/** Freeze a taxonomy for classification (stable ids; edits after this create new versions). */
export function freeze(t0: Taxonomy, now: number): Taxonomy {
  const t = clone(t0);
  validateTaxonomy(t);
  t.frozen = true;
  bump(t, now, true);
  return t;
}

export function unfreeze(t0: Taxonomy, now: number): Taxonomy {
  const t = clone(t0);
  t.frozen = false;
  t.updatedAt = now;
  return t;
}

/** Structural validation: unique ids, known parents, no cycles, sane names, unique sibling names. */
export function validateTaxonomy(t: Taxonomy): void {
  const ids = new Set<string>();
  for (const c of t.categories) {
    if (ids.has(c.id)) throw new TaxonomyError(`Duplicate category id ${c.id}`);
    ids.add(c.id);
    sanitizeCategoryName(c.name);
  }
  const siblings = new Map<string, Set<string>>();
  for (const c of t.categories) {
    if (c.parentId !== null && !ids.has(c.parentId)) throw new TaxonomyError(`Category ${c.id} has unknown parent`);
    pathOf(t, c.id); // throws on cycles
    if (c.status !== 'active') continue;
    const key = c.parentId ?? '(root)';
    const set = siblings.get(key) ?? siblings.set(key, new Set()).get(key)!;
    const f = foldText(c.name);
    if (set.has(f)) throw new TaxonomyError(`Duplicate sibling name "${c.name}"`);
    set.add(f);
  }
}

/** True when an assignment made against `assignedVersion` is still valid. */
export function assignmentCurrent(t: Taxonomy, assignedVersion: number, categoryId: string | null): boolean {
  if (assignedVersion < t.breakingVersion) return false;
  if (categoryId === null) return true;
  return activeCategories(t).some((c) => c.id === categoryId);
}

/** Additive category creation used by auto-filing (bumps version, not breakingVersion). */
export function addAutoCategory(t0: Taxonomy, input: NewCategoryInput, now: number): { taxonomy: Taxonomy; category: Category; reused: boolean } {
  const existing = findEquivalent(t0, input.name, input.parentId);
  if (existing) return { taxonomy: t0, category: existing, reused: true };
  const t = clone(t0);
  const c = makeCategory(t, { ...input, origin: 'auto-created' }, now);
  t.categories.push(c);
  bump(t, now, false);
  validateTaxonomy(t);
  return { taxonomy: t, category: c, reused: false };
}

export function taxonomyStats(t: Taxonomy): { total: number; top: number; maxDepth: number; leaves: number } {
  const act = activeCategories(t);
  const parents = new Set(act.map((c) => c.parentId).filter(Boolean));
  return {
    total: act.length,
    top: act.filter((c) => c.parentId === null).length,
    maxDepth: Math.max(0, ...act.map((c) => depthOf(t, c.id))),
    leaves: act.filter((c) => !parents.has(c.id)).length,
  };
}
