/**
 * Offline classifier against a taxonomy, plus the assignment record format
 * shared with AI providers and the precedence engine.
 *
 * Category vocabulary = linked lexicon concepts + the category's own name,
 * aliases, include terms and examples. User-created categories therefore
 * work without any lexicon entry.
 */
import { CONCEPTS_BY_KEY, LEXICON } from '../taxonomy/lexicon.ts';
import { activeCategories, byId, pathLabel, pathOf, type Category, type Taxonomy } from '../taxonomy/taxonomy.ts';
import { hashString, tokenize } from '../text.ts';
import { compileVocabulary, extractFacets, FOLDER_CAP, extractFeatures, matchVocabulary, type Channel, type Facets, type Features, type Hit, type ItemInput } from './features.ts';

export type Band = 'high' | 'medium' | 'low';
export type EvidenceSource = Channel | 'ai' | 'user' | 'user-rule' | 'protected';
export type ReviewReason = 'insufficient-evidence' | 'competing' | 'low-confidence' | 'weak-title' | 'ai-abstained' | 'ai-invalid' | 'new-category-suggested';

export interface Assignment {
  bookmarkId: string;
  taxonomyId: string;
  taxonomyVersion: number;
  /** null = unresolved (Needs Review) or intentionally left in place. */
  categoryId: string | null;
  tags: string[];
  facets: Facets;
  rationale: string;
  evidence: EvidenceSource[];
  band: Band | null;
  provider: 'rules' | 'chrome-ai' | 'gemini' | 'user' | 'user-rule' | 'protected';
  model?: string | undefined;
  promptVersion?: string | undefined;
  /** Hash of the inputs used; a changed title/URL invalidates the assignment. */
  inputHash: string;
  needsReview?: ReviewReason | undefined;
  competing?: string[] | undefined;
  /** Suggested new category (bulk mode: queued for review, never auto-applied). */
  suggestedCategory?: { name: string; parentId: string | null; definition?: string } | undefined;
  at: number;
}

export function inputHash(item: Pick<ItemInput, 'title' | 'url' | 'folderPath'>, extra = ''): string {
  return hashString(`${item.title}\u0001${item.url}\u0001${item.folderPath.join('/')}\u0001${extra}`);
}

export interface Thresholds {
  high: number;
  medium: number;
  low: number;
  highMargin: number;
  mediumMargin: number;
  /** Max secondary tags. */
  maxTags: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = { high: 2.2, medium: 1.2, low: 0.6, highMargin: 1.6, mediumMargin: 1.25, maxTags: 3 };

export interface CategoryScore {
  categoryId: string;
  score: number;
  channels: Set<Channel>;
  terms: Set<string>;
  domainHit?: string | undefined;
}

export class RulesClassifier {
  readonly taxonomy: Taxonomy;
  private readonly cats: Category[];
  private readonly catMap: Map<string, Category>;
  private readonly conceptVocab = compileVocabulary(LEXICON.map((c) => ({ key: c.key, terms: c.terms, negative: c.negative, domains: c.domains })));
  private readonly directVocab;
  private readonly conceptToCats = new Map<string, string[]>();
  private readonly thresholds: Thresholds;
  private readonly paths = new Map<string, string[]>();
  /** Folder evidence cap: weak in Discover mode, stronger when improving the existing structure. */
  private readonly folderCap: number;

  constructor(taxonomy: Taxonomy, thresholds: Thresholds = DEFAULT_THRESHOLDS) {
    this.taxonomy = taxonomy;
    this.folderCap = taxonomy.mode === 'improve' ? FOLDER_CAP * 2 : FOLDER_CAP;
    this.thresholds = thresholds;
    this.cats = activeCategories(taxonomy);
    this.catMap = byId(taxonomy);
    for (const c of this.cats) this.paths.set(c.id, pathOf(taxonomy, c.id).map((x) => x.id));
    for (const c of this.cats) {
      for (const k of c.conceptKeys) (this.conceptToCats.get(k) ?? this.conceptToCats.set(k, []).get(k)!).push(c.id);
    }
    this.directVocab = compileVocabulary(
      this.cats.map((c) => ({
        key: c.id,
        terms: [c.name, ...(c.nameFa ? [c.nameFa] : []), ...c.aliases, ...c.include]
          .map((s) => s.replace(/[&/,()]+/g, ' ').trim())
          .filter((s) => tokenize(s).length > 0 && tokenize(s).length <= 5),
      })),
    );
  }

  /** Raw per-category scores (category's own evidence + best child propagated). */
  score(f: Features): CategoryScore[] {
    const own = new Map<string, CategoryScore>();
    const credit = (catId: string, h: Hit, factor = 1) => {
      const s = own.get(catId) ?? own.set(catId, { categoryId: catId, score: 0, channels: new Set(), terms: new Set() }).get(catId)!;
      s.score += h.score * factor;
      for (const ch of h.channels) s.channels.add(ch);
      for (const t of h.terms) s.terms.add(t);
      if (h.domainHit) s.domainHit ??= h.domainHit;
    };
    for (const [key, h] of matchVocabulary(this.conceptVocab, f, undefined, this.folderCap)) {
      for (const cid of this.conceptToCats.get(key) ?? []) credit(cid, h);
    }
    // Direct name/alias matches: a phrase like "Real Estate" in a title is strong evidence.
    for (const [cid, h] of matchVocabulary(this.directVocab, f, undefined, this.folderCap)) {
      credit(cid, h, (this.catMap.get(cid)?.conceptKeys.length ?? 0) > 0 ? 0.5 : 1);
    }
    // Exclusion terms push down.
    for (const c of this.cats) {
      if (!c.exclude.length) continue;
      const s = own.get(c.id);
      if (!s) continue;
      const titleText = ` ${f.tokens.title.join(' ')} `;
      if (c.exclude.some((x) => tokenize(x).length && titleText.includes(` ${tokenize(x).join(' ')} `))) s.score *= 0.4;
    }
    // Ancestors receive part of a descendant's score so areas gather sub-topic evidence.
    const total = new Map<string, CategoryScore>();
    for (const s of own.values()) total.set(s.categoryId, { ...s, channels: new Set(s.channels), terms: new Set(s.terms) });
    for (const s of own.values()) {
      const path = this.pathIds(s.categoryId);
      for (const ancId of path.slice(0, -1)) {
        const t = total.get(ancId) ?? total.set(ancId, { categoryId: ancId, score: 0, channels: new Set(), terms: new Set() }).get(ancId)!;
        t.score += s.score * 0.6;
        for (const ch of s.channels) t.channels.add(ch);
        for (const term of s.terms) t.terms.add(term);
      }
    }
    return [...total.values()].filter((s) => s.score > 0).sort((a, b) => b.score - a.score);
  }

  pathIds(id: string): string[] {
    return this.paths.get(id) ?? [id];
  }

  classify(item: ItemInput, now: number): Assignment {
    const f = extractFeatures(item);
    const scores = this.score(f);
    const facets = extractFacets(f, item.url);
    const base = {
      bookmarkId: item.id,
      taxonomyId: this.taxonomy.id,
      taxonomyVersion: this.taxonomy.version,
      facets,
      provider: 'rules' as const,
      inputHash: inputHash(item),
      at: now,
    };
    const T = this.thresholds;
    if (!scores.length || scores[0]!.score < T.low) {
      return {
        ...base,
        categoryId: null,
        tags: [],
        band: null,
        evidence: [],
        rationale: f.weakTitle ? 'Title has no topical words and the domain gives no subject signal.' : 'No category vocabulary matched the title, URL or folder.',
        needsReview: f.weakTitle ? 'weak-title' : 'insufficient-evidence',
      };
    }
    // Most specific well-supported category: walk from the best-scoring
    // category down to a child that keeps most of its evidence.
    const scoreOf = new Map(scores.map((s) => [s.categoryId, s]));
    let chosen = scores[0]!;
    for (;;) {
      const kids = this.cats.filter((c) => c.parentId === chosen.categoryId).map((c) => scoreOf.get(c.id)).filter((s): s is CategoryScore => !!s);
      kids.sort((a, b) => b.score - a.score);
      const kid = kids[0];
      if (!kid || kid.score < T.medium * 0.8 || kid.score < chosen.score * 0.45) break;
      if (kids[1] && kids[1].score > kid.score / T.mediumMargin) break; // two children compete: stay at parent
      chosen = kid;
    }
    const chosenPath = new Set(this.pathIds(chosen.categoryId));
    const isRelated = (id: string) => chosenPath.has(id) || this.pathIds(id).includes(chosen.categoryId);
    const competitor = scores.find((s) => !isRelated(s.categoryId));
    const margin = competitor ? chosen.score / competitor.score : Infinity;
    const contentEvidence = chosen.channels.has('title') || chosen.channels.has('metadata') || chosen.channels.has('url') || !!chosen.domainHit;
    const onlyFolder = chosen.channels.size === 1 && chosen.channels.has('folder');
    const onlyDomain = !chosen.channels.has('title') && !chosen.channels.has('metadata') && !chosen.channels.has('url') && chosen.channels.has('domain');

    let band: Band;
    if (chosen.score >= T.high && margin >= T.highMargin && contentEvidence && !onlyDomain) band = 'high';
    else if (chosen.score >= T.medium && margin >= T.mediumMargin && contentEvidence) band = 'medium';
    else band = 'low';
    if (onlyFolder) band = 'low';

    const tags = scores
      .filter((s) => !isRelated(s.categoryId) && s.score >= T.medium && s.categoryId !== chosen.categoryId)
      .filter((s) => this.catMap.get(s.categoryId)?.parentId !== null || !scores.some((x) => this.catMap.get(x.categoryId)?.parentId === s.categoryId))
      .slice(0, T.maxTags)
      .map((s) => s.categoryId);

    const evidence = [...chosen.channels] as EvidenceSource[];
    const termList = [...chosen.terms].slice(0, 4).map((t) => `“${t.replace(/\*$/, '')}”`);
    let rationale: string;
    if (onlyFolder) rationale = `Based only on the existing folder name (${item.folderPath.slice(-1)[0] ?? ''}); content gave no signal.`;
    else if (onlyDomain) rationale = `Based only on the domain ${chosen.domainHit ?? f.host}${f.weakTitle ? '; title is generic' : ''}.`;
    else {
      const parts: string[] = [];
      if (termList.length) parts.push(`matched ${termList.join(', ')}`);
      if (chosen.domainHit) parts.push(`subject domain ${chosen.domainHit}`);
      if (chosen.channels.has('folder')) parts.push('folder name agrees');
      rationale = `${parts.join('; ')}.`.replace(/^./, (c) => c.toUpperCase());
    }
    const competingClose = competitor && competitor.score >= T.medium && margin < T.mediumMargin;
    const a: Assignment = {
      ...base,
      categoryId: chosen.categoryId,
      tags,
      band,
      evidence,
      rationale: rationale.slice(0, 240),
    };
    if (competingClose) {
      a.needsReview = 'competing';
      a.competing = [competitor.categoryId];
      a.rationale = `${a.rationale} Competes with ${pathLabel(this.taxonomy, competitor.categoryId)}.`.slice(0, 300);
    } else if (band === 'low') a.needsReview = f.weakTitle ? 'weak-title' : 'low-confidence';
    return a;
  }

  /** Top-K candidate categories for an item (AI shortlist). Always includes top-level areas. */
  shortlist(item: ItemInput, k = 8): string[] {
    const f = extractFeatures(item);
    const ids = this.score(f)
      .slice(0, k)
      .map((s) => s.categoryId);
    return [...new Set(ids)];
  }
}

/** Concept key → label, used by discovery and UI. */
export function conceptLabel(key: string): string {
  return CONCEPTS_BY_KEY.get(key)?.label ?? key;
}
