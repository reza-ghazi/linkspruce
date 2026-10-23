/**
 * Decision precedence for a bookmark's category:
 *   1. protected folders / excluded items and branches  → left in place
 *   2. explicit user assignment (manual override)
 *   3. approved user rules
 *   4. current taxonomy classification (AI or offline)
 *   5. fallback: Needs Review
 * Corrections are recorded; repeated corrections can *suggest* a rule, but a
 * sweeping rule is never created without review.
 */
import { assignmentCurrent, type Taxonomy } from '../taxonomy/taxonomy.ts';
import { foldText } from '../text.ts';
import { matchesExclusion } from '../url.ts';
import { inputHash, type Assignment } from './classifier.ts';
import type { ItemInput } from './features.ts';

export interface UserRule {
  id: string;
  kind: 'domain' | 'url-prefix' | 'title-contains';
  pattern: string;
  categoryId: string;
  approved: boolean;
  createdAt: number;
  source: 'user' | 'suggested';
}

export interface Override {
  /** null = keep where it is / never auto-move. */
  categoryId: string | null;
  at: number;
  reason: 'manual-assign' | 'manual-move' | 'undo' | 'keep';
}

export interface PrecedenceContext {
  taxonomy: Taxonomy;
  protectedFolderIds: ReadonlySet<string>;
  excludedBookmarkIds: ReadonlySet<string>;
  overrides: ReadonlyMap<string, Override>;
  rules: readonly UserRule[];
  /** Stored classification (AI or rules), if any. */
  stored?: Assignment | undefined;
  /** Classifier used when nothing valid is stored. */
  classify: (item: ItemInput) => Assignment;
  now: number;
}

export interface ItemWithLocation extends ItemInput {
  /** Folder ids from the top-level root down to the parent. */
  pathIds: string[];
}

export function ruleMatches(rule: UserRule, item: ItemInput): boolean {
  if (!rule.approved) return false;
  const p = rule.pattern.trim();
  if (!p) return false;
  switch (rule.kind) {
    case 'domain':
    case 'url-prefix':
      try {
        return matchesExclusion(new URL(item.url), p);
      } catch {
        return false;
      }
    case 'title-contains':
      return foldText(item.title).includes(foldText(p));
  }
}

export function resolveAssignment(item: ItemWithLocation, ctx: PrecedenceContext): Assignment {
  const base = { bookmarkId: item.id, taxonomyId: ctx.taxonomy.id, taxonomyVersion: ctx.taxonomy.version, tags: [], facets: {}, inputHash: inputHash(item), at: ctx.now };
  if (ctx.excludedBookmarkIds.has(item.id) || item.pathIds.some((p) => ctx.protectedFolderIds.has(p))) {
    return { ...base, categoryId: null, band: null, evidence: ['protected'], provider: 'protected', rationale: 'In a protected or excluded location; left unchanged.' };
  }
  const o = ctx.overrides.get(item.id);
  if (o) {
    if (o.categoryId === null) return { ...base, categoryId: null, band: null, evidence: ['user'], provider: 'user', rationale: 'You chose to keep this bookmark where it is.' };
    if (ctx.taxonomy.categories.some((c) => c.id === o.categoryId && c.status === 'active')) {
      return { ...base, categoryId: o.categoryId, band: 'high', evidence: ['user'], provider: 'user', rationale: 'Assigned by you.' };
    }
  }
  for (const r of ctx.rules) {
    if (ruleMatches(r, item) && ctx.taxonomy.categories.some((c) => c.id === r.categoryId && c.status === 'active')) {
      return { ...base, categoryId: r.categoryId, band: 'high', evidence: ['user-rule'], provider: 'user-rule', rationale: `Matches your rule (${r.kind}: ${r.pattern}).` };
    }
  }
  const s = ctx.stored;
  if (s && s.inputHash === base.inputHash && s.taxonomyId === ctx.taxonomy.id && assignmentCurrent(ctx.taxonomy, s.taxonomyVersion, s.categoryId)) return s;
  return ctx.classify(item);
}

export interface Correction {
  bookmarkId: string;
  site: string;
  fromCategoryId: string | null;
  toCategoryId: string | null;
  at: number;
}

/**
 * Suggest (never auto-approve) a domain rule when the user has made at least
 * `minCount` consistent corrections for one site and none contradict it.
 */
export function suggestRules(corrections: readonly Correction[], existing: readonly UserRule[], minCount = 3): Array<Omit<UserRule, 'id' | 'createdAt'>> {
  const bySite = new Map<string, Correction[]>();
  for (const c of corrections) if (c.site && c.toCategoryId) (bySite.get(c.site) ?? bySite.set(c.site, []).get(c.site)!).push(c);
  const out: Array<Omit<UserRule, 'id' | 'createdAt'>> = [];
  for (const [site, list] of bySite) {
    const targets = new Set(list.map((c) => c.toCategoryId));
    if (list.length < minCount || targets.size !== 1) continue;
    if (existing.some((r) => r.kind === 'domain' && r.pattern === site)) continue;
    out.push({ kind: 'domain', pattern: site, categoryId: list[0]!.toCategoryId!, approved: false, source: 'suggested' });
  }
  return out;
}
