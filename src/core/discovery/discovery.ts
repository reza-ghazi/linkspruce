/**
 * Collection-wide taxonomy discovery (offline stages).
 *
 * 1. inventory(): languages, weak titles, repeated URLs, topic signals and
 *    folder distribution over the whole selection.
 * 2. stratifiedSample(): representative, deduplicated samples for AI
 *    discovery, never "the first N" or the biggest domains.
 * 3. offlineDraft(): a rules-based draft hierarchy from supported concepts,
 *    labelled as offline so AI refinement can follow.
 * Plus folder-structure analysis for "Improve existing structure" and a
 * parser for "Use my taxonomy".
 */
import { compileVocabulary, extractFeatures, matchVocabulary, type ItemInput } from '../classify/features.ts';
import { CONCEPTS_BY_KEY, LEXICON, type Concept } from '../taxonomy/lexicon.ts';
import {
  applyEdit,
  emptyTaxonomy,
  GRANULARITY,
  type Category,
  type GranularityPreset,
  type Taxonomy,
  type TaxonomyMode,
} from '../taxonomy/taxonomy.ts';
import { foldText, isWeakTitle, jaccard, slugify, tokenize, type ScriptLang } from '../text.ts';
import { urlKeys } from '../url.ts';

const CONCEPT_VOCAB = compileVocabulary(LEXICON.map((c) => ({ key: c.key, terms: c.terms, negative: c.negative, domains: c.domains })));

export interface ConceptGuess {
  concept: string | null;
  area: string | null;
  score: number;
  /** True when the guess relies on folder names only. */
  folderOnly: boolean;
}

/** Best lexicon concept for an item (content first; folders as a weak hint). */
export function guessConcept(item: ItemInput, useFolder = true): ConceptGuess {
  const f = extractFeatures(item);
  const hits = matchVocabulary(CONCEPT_VOCAB, f, useFolder ? ['title', 'url', 'domain', 'folder', 'metadata'] : ['title', 'url', 'domain', 'metadata']);
  const areaScore = new Map<string, number>();
  let best: { key: string; score: number; folderOnly: boolean } | null = null;
  for (const [key, h] of hits) {
    const c = CONCEPTS_BY_KEY.get(key)!;
    const area = c.parent ?? c.key;
    areaScore.set(area, (areaScore.get(area) ?? 0) + h.score * (c.parent ? 1 : 0.8));
    if (c.parent && (!best || h.score > best.score)) best = { key, score: h.score, folderOnly: h.channels.size === 1 && h.channels.has('folder') };
  }
  let topArea: string | null = null;
  let topAreaScore = 0;
  for (const [a, s] of areaScore) if (s > topAreaScore) [topArea, topAreaScore] = [a, s];
  if (topAreaScore < 0.6) return { concept: null, area: null, score: 0, folderOnly: false };
  const leafOk = best && best.score >= 0.9 && CONCEPTS_BY_KEY.get(best.key)!.parent === topArea;
  return {
    concept: leafOk ? best!.key : topArea,
    area: topArea,
    score: leafOk ? best!.score : topAreaScore,
    folderOnly: !!(leafOk ? best!.folderOnly : false),
  };
}

export interface Inventory {
  total: number;
  uniqueUrls: number;
  repeatedUrlInstances: number;
  languages: Partial<Record<ScriptLang, number>>;
  weakTitles: number;
  unsupportedSchemes: number;
  platformHosted: number;
  topFolders: Array<{ name: string; count: number }>;
  folderCount: number;
  /** Concept → count, deduplicated by URL so repeated links don't dominate. */
  conceptSupport: Map<string, number>;
  areaSupport: Map<string, number>;
  unmatched: number;
  guesses: Map<string, ConceptGuess>;
  elapsedMs: number;
}

export function inventory(items: readonly ItemInput[], now: () => number = Date.now): Inventory {
  const t0 = now();
  const languages: Partial<Record<ScriptLang, number>> = {};
  const seenUrl = new Set<string>();
  const conceptSupport = new Map<string, number>();
  const areaSupport = new Map<string, number>();
  const folderCounts = new Map<string, number>();
  const folders = new Set<string>();
  const guesses = new Map<string, ConceptGuess>();
  let weak = 0;
  let unsupported = 0;
  let platform = 0;
  let unmatched = 0;
  let repeated = 0;
  for (const it of items) {
    const f = extractFeatures(it);
    languages[f.lang] = (languages[f.lang] ?? 0) + 1;
    if (f.weakTitle) weak++;
    if (f.platform) platform++;
    if (!/^https?:/i.test(it.url)) unsupported++;
    const top = it.folderPath[0] ?? '(top level)';
    folderCounts.set(top, (folderCounts.get(top) ?? 0) + 1);
    if (it.folderPath.length) folders.add(it.folderPath.join('\u0001'));
    const g = guessConcept(it);
    guesses.set(it.id, g);
    const key = urlKeys(it.url).trackingStripped;
    if (seenUrl.has(key)) {
      repeated++;
      continue; // count each distinct URL once for topic support
    }
    seenUrl.add(key);
    if (!g.concept) {
      unmatched++;
      continue;
    }
    conceptSupport.set(g.concept, (conceptSupport.get(g.concept) ?? 0) + 1);
    if (g.area) areaSupport.set(g.area, (areaSupport.get(g.area) ?? 0) + 1);
  }
  return {
    total: items.length,
    uniqueUrls: seenUrl.size,
    repeatedUrlInstances: repeated,
    languages,
    weakTitles: weak,
    unsupportedSchemes: unsupported,
    platformHosted: platform,
    topFolders: [...folderCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([name, count]) => ({ name, count })),
    folderCount: folders.size,
    conceptSupport,
    areaSupport,
    unmatched,
    guesses,
    elapsedMs: now() - t0,
  };
}

/** Deterministic PRNG (mulberry32) so samples are reproducible. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SampleOptions {
  size: number;
  seed: number;
  minPerStratum: number;
}

/**
 * Stratified sample over (topic area, language, weak-title) strata with
 * square-root allocation, so small subjects and minority languages are
 * represented. URLs are deduplicated; within a stratum, sites are drawn
 * round-robin so one large domain can't dominate.
 */
export function stratifiedSample(items: readonly ItemInput[], inv: Inventory, opts: SampleOptions): ItemInput[] {
  const strata = new Map<string, ItemInput[]>();
  const seen = new Set<string>();
  for (const it of items) {
    const k = urlKeys(it.url).trackingStripped;
    if (seen.has(k)) continue;
    seen.add(k);
    const g = inv.guesses.get(it.id);
    const lang = extractFeatures(it).lang;
    const key = `${g?.area ?? 'none'}|${lang === 'fa' || lang === 'ar' || lang === 'mixed' ? lang : 'other'}|${isWeakTitle(it.title) ? 'weak' : 'ok'}`;
    (strata.get(key) ?? strata.set(key, []).get(key)!).push(it);
  }
  const rand = rng(opts.seed);
  const keys = [...strata.keys()].sort();
  const sqrtTotal = keys.reduce((s, k) => s + Math.sqrt(strata.get(k)!.length), 0);
  const out: ItemInput[] = [];
  for (const k of keys) {
    const list = strata.get(k)!;
    const want = Math.min(list.length, Math.max(opts.minPerStratum, Math.round((opts.size * Math.sqrt(list.length)) / sqrtTotal)));
    // Group by site, shuffle each, then round-robin.
    const bySite = new Map<string, ItemInput[]>();
    for (const it of list) {
      const s = extractFeatures(it).site || '(none)';
      (bySite.get(s) ?? bySite.set(s, []).get(s)!).push(it);
    }
    const queues = [...bySite.values()].map((q) => shuffle(q, rand));
    shuffle(queues, rand);
    let taken = 0;
    while (taken < want) {
      let progressed = false;
      for (const q of queues) {
        if (taken >= want) break;
        const it = q.pop();
        if (it) {
          out.push(it);
          taken++;
          progressed = true;
        }
      }
      if (!progressed) break;
    }
  }
  // Trim proportionally if minimums pushed us over the target.
  return out.length > opts.size * 1.25 ? shuffle(out, rand).slice(0, Math.round(opts.size * 1.25)) : out;
}

function shuffle<T>(arr: T[], rand: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}

function conceptToInput(c: Concept, parentId: string | null, count: number, estimate: boolean) {
  return {
    id: `cat_${slugify(c.label)}`,
    name: c.label,
    nameFa: c.labelFa,
    parentId,
    definition: c.definition,
    conceptKeys: [c.key],
    aliases: [],
    origin: 'discovered' as const,
    estimatedCount: count,
    estimate,
  };
}

export interface DraftResult {
  taxonomy: Taxonomy;
  notes: string[];
}

/**
 * Offline (rules-only) draft hierarchy: lexicon areas and sub-topics that
 * the collection actually supports, sized by the granularity preset.
 * Concepts placed in the lexicon under another area (e.g. integer
 * factoring under mathematics) follow the lexicon parent.
 */
export function offlineDraft(inv: Inventory, id: string, now: number, preset: GranularityPreset = 'balanced', mode: TaxonomyMode = 'discover'): DraftResult {
  const g = GRANULARITY[preset];
  let t = emptyTaxonomy(id, now, mode, preset);
  t.discoveredBy = 'rules';
  const notes: string[] = [];
  const areas = LEXICON.filter((c) => !c.parent)
    .map((a) => ({ a, n: (inv.areaSupport.get(a.key) ?? 0) }))
    .filter((x) => x.n > 0)
    .sort((x, y) => y.n - x.n);
  const minArea = Math.max(3, Math.round(g.minLeaf * 1.5));
  let kept = areas.filter((x) => x.n >= minArea);
  if (kept.length > g.topMax) {
    notes.push(`${kept.length - g.topMax} small subject areas folded into review (top-level limit ${g.topMax}).`);
    kept = kept.slice(0, g.topMax);
  }
  if (kept.length < Math.min(g.topMin, areas.length)) kept = areas.slice(0, Math.min(g.topMin, areas.length));
  for (const { a, n } of kept) {
    const allKids = LEXICON.filter((c) => c.parent === a.key).map((c) => ({ c, n: inv.conceptSupport.get(c.key) ?? 0 }));
    const kids = g.maxDepth < 2 ? [] : allKids.filter((x) => x.n >= g.minLeaf).sort((x, y) => y.n - x.n);
    // Sub-topics without enough support fold into the area, which inherits their vocabulary.
    const folded = allKids.filter((x) => !kids.includes(x)).map((x) => x.c.key);
    const areaInput = conceptToInput(a, null, n, false);
    areaInput.conceptKeys = [a.key, ...folded];
    t = applyEdit(t, { op: 'add', input: areaInput }, now);
    for (const { c, n: kn } of kids) {
      t = applyEdit(t, { op: 'add', input: conceptToInput(c, `cat_${slugify(a.label)}`, kn, false) }, now);
    }
  }
  const dropped = areas.filter((x) => !kept.includes(x));
  if (dropped.length) notes.push(`Not enough support for: ${dropped.map((x) => `${x.a.label} (${x.n})`).join(', ')}. Their items go to Needs Review unless you add these categories.`);
  notes.push('Offline draft: built from title/URL vocabulary. Counts come from offline rules over every selected bookmark, not from AI.');
  t.notes = notes;
  return { taxonomy: t, notes };
}

export interface StructureFinding {
  kind: 'merge' | 'split' | 'rename' | 'misplaced' | 'mixed-principle';
  folderIds: string[];
  message: string;
  bookmarkIds?: string[];
  suggestion?: string;
}

export interface FolderInfo {
  id: string;
  title: string;
  path: string[];
  bookmarkIds: string[];
}

const NON_SUBJECT_FOLDER = /^(misc|miscellaneous|other|others|new folder|unsorted|temp|tmp|to read|read later|later|inbox|stuff|links|bookmarks|imported|folder|untitled|todo|جدید|متفرقه|سایر)( \d+)?$/i;
const FORMAT_FOLDER = /^(videos?|youtube|pdfs?|books?|papers?|articles?|tools?|software|apps?|github|courses?|podcasts?|blogs?|ویدیو|کتاب|مقاله|ابزار)$/i;

/** Analyse an existing folder structure for "Improve existing structure" mode. */
export function analyseStructure(folders: readonly FolderInfo[], items: ReadonlyMap<string, ItemInput>): StructureFinding[] {
  const findings: StructureFinding[] = [];
  const dominant = new Map<string, { area: string | null; share: number; areas: Map<string, number> }>();
  for (const f of folders) {
    const areas = new Map<string, number>();
    for (const id of f.bookmarkIds) {
      const it = items.get(id);
      if (!it) continue;
      const g = guessConcept({ ...it, folderPath: [] }, false);
      if (g.area) areas.set(g.area, (areas.get(g.area) ?? 0) + 1);
    }
    const total = f.bookmarkIds.length;
    let top: string | null = null;
    let topN = 0;
    for (const [a, n] of areas) if (n > topN) [top, topN] = [a, n];
    dominant.set(f.id, { area: top, share: total ? topN / total : 0, areas });
    if (NON_SUBJECT_FOLDER.test(f.title.trim())) {
      findings.push({ kind: 'rename', folderIds: [f.id], message: `“${f.title}” does not describe a subject.`, suggestion: top ? `Consider distributing its ${total} bookmarks by topic (mostly ${CONCEPTS_BY_KEY.get(top)?.label}).` : 'Consider distributing its bookmarks by topic.' });
    } else if (FORMAT_FOLDER.test(foldText(f.title))) {
      findings.push({ kind: 'mixed-principle', folderIds: [f.id], message: `“${f.title}” groups by resource format rather than subject. LinkSpruce can keep format as a tag instead.` });
    }
    // Split: a big folder whose contents span several strong areas.
    const strong = [...areas.entries()].filter(([, n]) => n >= Math.max(5, total * 0.2));
    if (total >= 30 && strong.length >= 2) {
      findings.push({ kind: 'split', folderIds: [f.id], message: `“${f.title}” mixes ${strong.map(([a, n]) => `${CONCEPTS_BY_KEY.get(a)?.label} (${n})`).join(', ')}.`, suggestion: 'Split into subject sub-folders.' });
    }
  }
  // Merge: folders with equivalent names (case/script folding, aliases, token overlap) in different places.
  const byFolded = new Map<string, FolderInfo[]>();
  for (const f of folders) {
    const toks = tokenize(f.title);
    const key = toks.sort().join(' ') || foldText(f.title);
    (byFolded.get(key) ?? byFolded.set(key, []).get(key)!).push(f);
  }
  for (const [, list] of byFolded) {
    if (list.length > 1 && list.some((x) => x.bookmarkIds.length)) {
      findings.push({ kind: 'merge', folderIds: list.map((x) => x.id), message: `${list.length} folders named like “${list[0]!.title}” exist in different places: ${list.map((x) => [...x.path, x.title].join(' › ')).slice(0, 4).join('; ')}.`, suggestion: 'Merge them into one category.' });
    }
  }
  // Synonym merges via lexicon (e.g. "ML" and "Machine Learning").
  const conceptOfName = new Map<string, FolderInfo[]>();
  for (const f of folders) {
    const g = guessConcept({ id: f.id, title: f.title, url: '', folderPath: [] }, false);
    if (g.concept && g.score >= 1) (conceptOfName.get(g.concept) ?? conceptOfName.set(g.concept, []).get(g.concept)!).push(f);
  }
  for (const [concept, list] of conceptOfName) {
    const names = new Set(list.map((f) => foldText(f.title)));
    if (list.length > 1 && names.size > 1 && list.filter((f) => f.bookmarkIds.length >= 3).length >= 2) {
      const already = findings.some((x) => x.kind === 'merge' && list.every((f) => x.folderIds.includes(f.id)));
      if (!already) findings.push({ kind: 'merge', folderIds: list.map((f) => f.id), message: `Folders ${list.slice(0, 4).map((f) => `“${f.title}”`).join(', ')} all appear to cover ${CONCEPTS_BY_KEY.get(concept)?.label}.`, suggestion: 'Consider merging or nesting them.' });
    }
  }
  // Misplaced items: strong content evidence for a different area than the folder's dominant one.
  for (const f of folders) {
    const d = dominant.get(f.id)!;
    if (!d.area || d.share < 0.6 || f.bookmarkIds.length < 8) continue;
    const odd: string[] = [];
    for (const id of f.bookmarkIds) {
      const it = items.get(id);
      if (!it) continue;
      const g = guessConcept({ ...it, folderPath: [] }, false);
      if (g.area && g.area !== d.area && g.score >= 2) odd.push(id);
    }
    if (odd.length) findings.push({ kind: 'misplaced', folderIds: [f.id], bookmarkIds: odd.slice(0, 200), message: `${odd.length} bookmark(s) in “${f.title}” look like a different subject than the rest (${CONCEPTS_BY_KEY.get(d.area)?.label}).` });
  }
  return findings;
}

/** Build a taxonomy from existing folders (Improve mode): folders with enough bookmarks become categories. */
export function taxonomyFromFolders(folders: readonly FolderInfo[], id: string, now: number, preset: GranularityPreset = 'balanced'): Taxonomy {
  const g = GRANULARITY[preset];
  let t = emptyTaxonomy(id, now, 'improve', preset);
  t.discoveredBy = 'folders';
  const byPath = new Map<string, FolderInfo>();
  for (const f of folders) byPath.set([...f.path, f.title].join('\u0001'), f);
  const subtreeCount = (f: FolderInfo): number => {
    const prefix = [...f.path, f.title].join('\u0001');
    let n = 0;
    for (const [p, x] of byPath) if (p === prefix || p.startsWith(`${prefix}\u0001`)) n += x.bookmarkIds.length;
    return n;
  };
  const idByPath = new Map<string, string>();
  const sorted = [...folders].sort((a, b) => a.path.length - b.path.length);
  for (const f of sorted) {
    // Skip permanent roots (depth 0: Bookmarks bar / Other bookmarks).
    if (f.path.length === 0) continue;
    const rel = f.path.slice(1);
    if (rel.length >= g.maxDepth) continue;
    const n = subtreeCount(f);
    if (n < g.minLeaf || NON_SUBJECT_FOLDER.test(f.title.trim())) continue;
    const parentKey = f.path.join('\u0001');
    const parentId = idByPath.get(parentKey) ?? null;
    if (rel.length > 0 && !parentId) continue;
    const gc = guessConcept({ id: f.id, title: f.title, url: '', folderPath: [] }, false);
    try {
      t = applyEdit(t, { op: 'add', input: { name: f.title.slice(0, 60), parentId, definition: `Existing folder “${f.title}”.`, conceptKeys: gc.concept ? [gc.concept] : [], origin: 'imported', estimatedCount: n, estimate: false } }, now);
      idByPath.set([...f.path, f.title].join('\u0001'), t.categories[t.categories.length - 1]!.id);
    } catch {
      /* duplicate sibling or invalid name: skip */
    }
  }
  return t;
}

/**
 * Parse a user taxonomy from indented text:
 *   Astronomy
 *     Celestial Mechanics | orbits, astrodynamics
 *   Real Estate
 * "|" introduces comma-separated aliases. Tabs or 2+ spaces indent.
 */
export function parseUserTaxonomy(text: string, id: string, now: number, preset: GranularityPreset = 'balanced'): Taxonomy {
  let t = emptyTaxonomy(id, now, 'user', preset);
  t.granularity.maxDepth = 6;
  t.discoveredBy = 'user';
  const stack: Array<{ indent: number; id: string }> = [];
  const lines = text.split(/\r?\n/);
  if (lines.length > 2000) throw new Error('Taxonomy text is too long');
  for (const raw of lines) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const indent = raw.replace(/\t/g, '    ').match(/^ */)![0].length;
    const [namePart, aliasPart] = raw.trim().replace(/^[-*•]\s*/, '').split('|');
    while (stack.length && stack[stack.length - 1]!.indent >= indent) stack.pop();
    const parentId = stack[stack.length - 1]?.id ?? null;
    const name = (namePart ?? '').trim();
    const gc = guessConcept({ id: 'x', title: name, url: '', folderPath: [] }, false);
    t = applyEdit(t, { op: 'add', input: { name, parentId, aliases: (aliasPart ?? '').split(',').map((s) => s.trim()).filter(Boolean), conceptKeys: gc.concept ? [gc.concept] : [], origin: 'user', definition: '' } }, now);
    stack.push({ indent, id: t.categories[t.categories.length - 1]!.id });
  }
  return t;
}

/** Simple consistency checks on a taxonomy plus counts. */
export interface ConsistencyIssue {
  kind: 'overlapping-siblings' | 'overbroad' | 'tiny' | 'mixed-principle' | 'platform-category' | 'empty';
  categoryIds: string[];
  message: string;
}

const PLATFORM_NAME = /^(github|youtube|wikipedia|google drive|drive|reddit|twitter|x|medium|amazon|telegram)$/i;

export function consistencyPass(t: Taxonomy, counts: ReadonlyMap<string, number>, totalAssigned: number): ConsistencyIssue[] {
  const issues: ConsistencyIssue[] = [];
  const act = t.categories.filter((c) => c.status === 'active');
  const kids = (pid: string | null) => act.filter((c) => c.parentId === pid);
  const visit = (pid: string | null) => {
    const sibs = kids(pid);
    for (let i = 0; i < sibs.length; i++) {
      for (let j = i + 1; j < sibs.length; j++) {
        const a = sibs[i]!;
        const b = sibs[j]!;
        const sa = new Set([...tokenize(a.name), ...a.aliases.flatMap((x) => tokenize(x))]);
        const sb = new Set([...tokenize(b.name), ...b.aliases.flatMap((x) => tokenize(x))]);
        const sharedConcept = a.conceptKeys.some((k) => b.conceptKeys.includes(k));
        if (sharedConcept || jaccard(sa, sb) >= 0.5) issues.push({ kind: 'overlapping-siblings', categoryIds: [a.id, b.id], message: `“${a.name}” and “${b.name}” overlap.` });
      }
    }
    for (const c of sibs) visit(c.id);
  };
  visit(null);
  for (const c of act) {
    const n = counts.get(c.id) ?? 0;
    if (totalAssigned > 200 && n / totalAssigned > 0.25 && c.parentId !== null) issues.push({ kind: 'overbroad', categoryIds: [c.id], message: `“${c.name}” holds ${n} bookmarks (${Math.round((100 * n) / totalAssigned)}%); consider splitting.` });
    if (n > 0 && n < 3 && !c.pinned && c.origin !== 'user') issues.push({ kind: 'tiny', categoryIds: [c.id], message: `“${c.name}” has only ${n} bookmark(s).` });
    if (n === 0 && !kids(c.id).length && c.origin === 'discovered') issues.push({ kind: 'empty', categoryIds: [c.id], message: `“${c.name}” received no bookmarks.` });
    if (FORMAT_FOLDER.test(foldText(c.name))) issues.push({ kind: 'mixed-principle', categoryIds: [c.id], message: `“${c.name}” is a resource format; formats work better as tags.` });
    if (PLATFORM_NAME.test(c.name.trim())) issues.push({ kind: 'platform-category', categoryIds: [c.id], message: `“${c.name}” is a platform; platforms host unrelated subjects.` });
  }
  return issues;
}

export function categoryForConcept(t: Taxonomy, conceptKey: string): Category | undefined {
  return t.categories.find((c) => c.status === 'active' && c.conceptKeys.includes(conceptKey));
}
