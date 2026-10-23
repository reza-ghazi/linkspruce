/**
 * Strict validation of model output. Anything malformed, unknown,
 * duplicated or outside the allowlists is rejected item-by-item and
 * reported; nothing from the model is executed or trusted as a command.
 */
import { sanitizeCategoryName, TaxonomyError } from '../taxonomy/taxonomy.ts';

export interface ValidationReport {
  accepted: number;
  rejected: Array<{ index?: number | undefined; reason: string }>;
  missing: number[];
}

const EVIDENCE = new Set(['title', 'url', 'domain', 'folder', 'metadata']);
const CONF = new Set(['high', 'medium', 'low']);

/** Strip control/bidi characters and clamp model-provided prose. */
export function cleanText(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
   
  return v.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export interface ValidClassification {
  index: number;
  categoryId: string | null;
  tags: string[];
  conf: 'high' | 'medium' | 'low';
  evidence: string[];
  why: string;
  newCat?: { name: string; parentId: string | null; definition: string } | undefined;
}

export function validateClassification(
  raw: unknown,
  batchIndices: readonly number[],
  allowedCategoryIds: ReadonlySet<string>,
  allowNew: boolean,
): { items: ValidClassification[]; report: ValidationReport } {
  const report: ValidationReport = { accepted: 0, rejected: [], missing: [] };
  const items: ValidClassification[] = [];
  if (!isObj(raw) || !Array.isArray(raw.results)) {
    report.rejected.push({ reason: 'Response is not {results: [...]}' });
    report.missing = [...batchIndices];
    return { items, report };
  }
  const expected = new Set(batchIndices);
  const seen = new Set<number>();
  for (const r of raw.results.slice(0, batchIndices.length * 2)) {
    if (!isObj(r) || typeof r.i !== 'number' || !Number.isInteger(r.i)) {
      report.rejected.push({ reason: 'Result without integer index' });
      continue;
    }
    const index = r.i;
    if (!expected.has(index)) {
      report.rejected.push({ index, reason: 'Unknown index' });
      continue;
    }
    if (seen.has(index)) {
      report.rejected.push({ index, reason: 'Duplicate assignment' });
      // A duplicate makes both answers untrustworthy.
      const prev = items.findIndex((x) => x.index === index);
      if (prev >= 0) items.splice(prev, 1);
      continue;
    }
    seen.add(index);
    const c = r.c;
    if (c !== null && (typeof c !== 'string' || !allowedCategoryIds.has(c))) {
      report.rejected.push({ index, reason: `Unknown category id` });
      continue;
    }
    const conf = typeof r.conf === 'string' && CONF.has(r.conf) ? (r.conf as ValidClassification['conf']) : null;
    if (!conf) {
      report.rejected.push({ index, reason: 'Missing confidence band' });
      continue;
    }
    const tags = Array.isArray(r.tags) ? [...new Set(r.tags.filter((t): t is string => typeof t === 'string' && allowedCategoryIds.has(t) && t !== c))].slice(0, 3) : [];
    const evidence = Array.isArray(r.ev) ? [...new Set(r.ev.filter((e): e is string => typeof e === 'string' && EVIDENCE.has(e)))] : [];
    const v: ValidClassification = { index, categoryId: c, tags, conf, evidence, why: cleanText(r.why, 200) };
    if (allowNew && isObj(r.newCat) && c === null) {
      try {
        const name = sanitizeCategoryName(cleanText(r.newCat.name, 80));
        const parent = r.newCat.parent;
        if (parent !== null && (typeof parent !== 'string' || !allowedCategoryIds.has(parent))) throw new TaxonomyError('Unknown parent');
        v.newCat = { name, parentId: parent, definition: cleanText(r.newCat.definition, 300) };
      } catch (e) {
        report.rejected.push({ index, reason: `Invalid new category: ${(e as Error).message}` });
      }
    }
    items.push(v);
  }
  report.accepted = items.length;
  report.missing = batchIndices.filter((i) => !items.some((x) => x.index === i));
  return { items, report };
}

export interface ValidDiscovery {
  assignments: Map<number, string | null>;
  newCandidates: Array<{ key: string; name: string; parent: string | null; definition: string }>;
}

export function validateDiscovery(raw: unknown, batchIndices: readonly number[], existingIds: ReadonlySet<string>): { result: ValidDiscovery; report: ValidationReport } {
  const report: ValidationReport = { accepted: 0, rejected: [], missing: [] };
  const result: ValidDiscovery = { assignments: new Map(), newCandidates: [] };
  if (!isObj(raw) || !Array.isArray(raw.assignments)) {
    report.rejected.push({ reason: 'Response is not {assignments: [...]}' });
    report.missing = [...batchIndices];
    return { result, report };
  }
  const newKeys = new Set<string>();
  if (Array.isArray(raw.newCandidates)) {
    for (const n of raw.newCandidates.slice(0, 20)) {
      if (!isObj(n) || typeof n.key !== 'string' || !/^[a-z0-9_-]{1,16}$/i.test(n.key) || existingIds.has(n.key) || newKeys.has(n.key)) {
        report.rejected.push({ reason: 'Invalid new candidate key' });
        continue;
      }
      try {
        const name = sanitizeCategoryName(cleanText(n.name, 80));
        const parent = typeof n.parent === 'string' && existingIds.has(n.parent) ? n.parent : null;
        result.newCandidates.push({ key: n.key, name, parent, definition: cleanText(n.definition, 300) });
        newKeys.add(n.key);
      } catch (e) {
        report.rejected.push({ reason: `Invalid candidate name: ${(e as Error).message}` });
      }
    }
  }
  const expected = new Set(batchIndices);
  const dup = new Set<number>();
  for (const a of raw.assignments.slice(0, batchIndices.length * 2)) {
    if (!isObj(a) || typeof a.i !== 'number' || !expected.has(a.i)) {
      report.rejected.push({ reason: 'Unknown or missing index' });
      continue;
    }
    if (result.assignments.has(a.i)) {
      dup.add(a.i);
      continue;
    }
    if (a.c !== null && (typeof a.c !== 'string' || (!existingIds.has(a.c) && !newKeys.has(a.c)))) {
      report.rejected.push({ index: a.i, reason: 'Unknown candidate' });
      continue;
    }
    result.assignments.set(a.i, a.c as string | null);
  }
  for (const d of dup) {
    result.assignments.delete(d);
    report.rejected.push({ index: d, reason: 'Duplicate assignment' });
  }
  report.accepted = result.assignments.size;
  report.missing = batchIndices.filter((i) => !result.assignments.has(i));
  return { result, report };
}

export interface ValidSynthCategory {
  key: string;
  name: string;
  parent: string | null;
  definition: string;
  include: string[];
  exclude: string[];
  aliases: string[];
  members: string[];
}

/**
 * Validate a synthesized hierarchy: unique keys, existing parents, no
 * cycles, depth limit, every candidate covered exactly once. Unknown member
 * keys are dropped; uncovered candidates are reported for the caller to
 * attach.
 */
export function validateSynthesis(raw: unknown, candidateKeys: ReadonlySet<string>, maxDepth: number): { categories: ValidSynthCategory[]; uncovered: string[]; report: ValidationReport } {
  const report: ValidationReport = { accepted: 0, rejected: [], missing: [] };
  if (!isObj(raw) || !Array.isArray(raw.categories)) {
    report.rejected.push({ reason: 'Response is not {categories: [...]}' });
    return { categories: [], uncovered: [...candidateKeys], report };
  }
  const cats: ValidSynthCategory[] = [];
  const keys = new Set<string>();
  const covered = new Set<string>();
  const list = (v: unknown, n: number, len: number) => (Array.isArray(v) ? v.map((x) => cleanText(x, len)).filter(Boolean).slice(0, n) : []);
  for (const c of raw.categories.slice(0, 400)) {
    if (!isObj(c) || typeof c.key !== 'string' || !c.key || keys.has(c.key)) {
      report.rejected.push({ reason: 'Invalid or duplicate category key' });
      continue;
    }
    let name: string;
    try {
      name = sanitizeCategoryName(cleanText(c.name, 80));
    } catch (e) {
      report.rejected.push({ reason: `Invalid name: ${(e as Error).message}` });
      continue;
    }
    const members = (Array.isArray(c.members) ? c.members : []).filter((m): m is string => typeof m === 'string' && candidateKeys.has(m) && !covered.has(m));
    for (const m of members) covered.add(m);
    keys.add(c.key);
    cats.push({
      key: c.key,
      name,
      parent: typeof c.parent === 'string' ? c.parent : null,
      definition: cleanText(c.definition, 300),
      include: list(c.include, 8, 100),
      exclude: list(c.exclude, 8, 100),
      aliases: list(c.aliases, 12, 60),
      members,
    });
  }
  // Parents must exist and form a forest within the depth limit.
  const byKey = new Map(cats.map((c) => [c.key, c]));
  for (const c of cats) if (c.parent !== null && !byKey.has(c.parent)) c.parent = null;
  for (const c of cats) {
    const seen = new Set<string>();
    let d = 1;
    for (let p = c.parent; p !== null; p = byKey.get(p)?.parent ?? null) {
      if (seen.has(p) || p === c.key) {
        c.parent = null; // break cycles at this node
        report.rejected.push({ reason: `Cycle at ${c.key}` });
        break;
      }
      seen.add(p);
      d++;
    }
    if (d > maxDepth) {
      c.parent = null;
      report.rejected.push({ reason: `Depth limit at ${c.key}` });
    }
  }
  report.accepted = cats.length;
  const uncovered = [...candidateKeys].filter((k) => !covered.has(k));
  return { categories: cats, uncovered, report };
}

/** Parse a JSON string from a model, tolerating code fences. */
export function parseModelJson(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(t);
}
