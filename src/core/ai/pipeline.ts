/**
 * AI-assisted discovery and classification over bounded batches.
 *
 * Discovery keeps one global candidate list: every batch sees the current
 * candidates and may only add a few, which are de-duplicated against
 * existing names/aliases, so batches cannot invent unrelated trees. A
 * synthesis call then organises candidates into a hierarchy; if it fails
 * validation a deterministic fallback builds one from candidate parents.
 *
 * State objects are plain JSON so the background job runner can checkpoint
 * them between batches and resume after interruption.
 */
import { DEFAULT_THRESHOLDS, inputHash, RulesClassifier, type Assignment, type Band, type EvidenceSource } from '../classify/classifier.ts';
import type { ItemInput } from '../classify/features.ts';
import { guessConcept } from '../discovery/discovery.ts';
import { activeCategories, applyEdit, emptyTaxonomy, pathLabel, type Granularity, type Taxonomy } from '../taxonomy/taxonomy.ts';
import { foldText, jaccard, tokenize } from '../text.ts';
import { redactUrl } from '../url.ts';
import { BudgetExceeded, checkBudget, record, type Budget, type UsageLedger } from './budget.ts';
import {
  classifyPrompt,
  classifySchema,
  classifySystem,
  DISCOVER_SCHEMA,
  discoverPrompt,
  discoverSystem,
  PROMPT_VERSION,
  SYNTHESIZE_SCHEMA,
  synthesizePrompt,
  synthesizeSystem,
  type PromptItem,
} from './prompts.ts';
import { estimateTokens, ProviderError, type AiProvider, type GenerateRequest } from './types.ts';
import { validateClassification, validateDiscovery, validateSynthesis } from './validate.ts';

export interface DataPolicy {
  /** Send the URL path (redacted) in addition to the host. */
  includePath: boolean;
  /** Send the last two folder names as weak hints. */
  includeFolderHints: boolean;
  /** Send cached page title/description when available. */
  includeMetadata: boolean;
}

export const DEFAULT_DATA_POLICY: DataPolicy = { includePath: true, includeFolderHints: false, includeMetadata: false };

export interface AiContext {
  provider: AiProvider;
  budget: Budget;
  ledger: UsageLedger;
  policy: DataPolicy;
  labelLanguage: string;
  signal?: AbortSignal | undefined;
  /** Persist ledger after each call (called before results are used). */
  onUsage?: ((l: UsageLedger) => Promise<void> | void) | undefined;
}

export function toPromptItem(item: ItemInput, i: number, policy: DataPolicy): PromptItem {
  const p: PromptItem = { i, t: item.title.replace(/\s+/g, ' ').trim().slice(0, 140), u: redactUrl(item.url, { keepPath: policy.includePath }) };
  if (policy.includeFolderHints && item.folderPath.length) p.f = item.folderPath.slice(-2).join(' / ').slice(0, 80);
  if (policy.includeMetadata && item.meta) {
    const m = [item.meta.title, item.meta.description].filter(Boolean).join(' — ').slice(0, 200);
    if (m) p.m = m;
  }
  return p;
}

/** Describe exactly which fields a provider call would transmit (for the consent screen). */
export function describeTransmission(policy: DataPolicy): string[] {
  const out = ['Bookmark titles (truncated to 140 characters)', policy.includePath ? 'Website host and URL path, with query strings, fragments, credentials and ID-like segments removed' : 'Website host name only'];
  if (policy.includeFolderHints) out.push('The last two folder names of each bookmark');
  if (policy.includeMetadata) out.push('Cached page title/description fetched during link checks');
  out.push('Category names and definitions from your taxonomy');
  return out;
}

async function call(ctx: AiContext, req: Omit<GenerateRequest, 'signal'>): Promise<unknown> {
  const estIn = estimateTokens(req.system + req.prompt + JSON.stringify(req.schema));
  if (ctx.provider.kind === 'cloud') checkBudget(ctx.budget, ctx.ledger, ctx.provider.model, estIn, Math.round(req.maxOutputTokens * 0.6));
  const res = await ctx.provider.generate({ ...req, signal: ctx.signal });
  ctx.ledger = record(ctx.ledger, ctx.provider.model, res.usage);
  await ctx.onUsage?.(ctx.ledger);
  return res.data;
}

// ───────────────────────── Discovery

export interface Candidate {
  id: string;
  name: string;
  parent: string | null;
  definition: string;
  aliases: string[];
  count: number;
}

export interface DiscoveryState {
  v: 1;
  candidates: Candidate[];
  /** sample item id → candidate id or null */
  assignments: Record<string, string | null>;
  nextKey: number;
  batches: number;
  rejected: number;
  missing: number;
}

export function newDiscoveryState(): DiscoveryState {
  return { v: 1, candidates: [], assignments: {}, nextKey: 1, batches: 0, rejected: 0, missing: 0 };
}

function equivalentCandidate(cands: readonly Candidate[], name: string): Candidate | undefined {
  const f = foldText(name);
  const toks = tokenize(name);
  let best: { c: Candidate; s: number } | undefined;
  for (const c of cands) {
    if (foldText(c.name) === f || c.aliases.some((a) => foldText(a) === f)) return c;
    const s = jaccard(toks, tokenize(c.name));
    if (s >= 0.8 && (!best || s > best.s)) best = { c, s };
  }
  return best?.c;
}

/** Show the model the most-used candidates when the list grows large. */
function candidateView(state: DiscoveryState, max = 140) {
  return [...state.candidates]
    .sort((a, b) => b.count - a.count)
    .slice(0, max)
    .map((c) => ({ id: c.id, name: c.name, d: c.definition.slice(0, 90) }));
}

export async function discoveryBatch(state: DiscoveryState, items: readonly ItemInput[], ctx: AiContext): Promise<DiscoveryState> {
  const s: DiscoveryState = JSON.parse(JSON.stringify(state)) as DiscoveryState;
  const prompts = items.map((it, i) => toPromptItem(it, i, ctx.policy));
  const data = await call(ctx, {
    task: 'discover',
    system: discoverSystem(ctx.labelLanguage),
    prompt: discoverPrompt(candidateView(s), prompts),
    schema: DISCOVER_SCHEMA,
    maxOutputTokens: 120 + items.length * 18 + 600,
  });
  const existing = new Set(s.candidates.map((c) => c.id));
  const { result, report } = validateDiscovery(data, prompts.map((p) => p.i), existing);
  const keyMap = new Map<string, string>();
  for (const n of result.newCandidates) {
    const eq = equivalentCandidate(s.candidates, n.name);
    if (eq) {
      keyMap.set(n.key, eq.id);
      continue;
    }
    const id = `k${s.nextKey++}`;
    s.candidates.push({ id, name: n.name, parent: n.parent, definition: n.definition, aliases: [], count: 0 });
    keyMap.set(n.key, id);
  }
  for (const [i, c] of result.assignments) {
    const item = items[i]!;
    const cid = c === null ? null : (keyMap.get(c) ?? c);
    const prev = s.assignments[item.id];
    if (prev) {
      const pc = s.candidates.find((x) => x.id === prev);
      if (pc) pc.count--;
    }
    s.assignments[item.id] = cid;
    if (cid) {
      const cc = s.candidates.find((x) => x.id === cid);
      if (cc) cc.count++;
    }
  }
  s.batches++;
  s.rejected += report.rejected.length;
  s.missing += report.missing.length;
  return s;
}

export interface SynthesisResult {
  taxonomy: Taxonomy;
  usedFallback: boolean;
  notes: string[];
}

/** Turn discovery candidates into a draft taxonomy with estimated counts. */
export async function synthesizeTaxonomy(
  state: DiscoveryState,
  ctx: AiContext,
  g: Granularity,
  opts: { id: string; now: number; sampleSize: number; selectedTotal: number },
): Promise<SynthesisResult> {
  const notes: string[] = [];
  const scale = opts.sampleSize > 0 ? opts.selectedTotal / opts.sampleSize : 1;
  const used = state.candidates.filter((c) => c.count > 0);
  const keys = new Set(used.map((c) => c.id));
  let cats: Array<{ key: string; name: string; parent: string | null; definition: string; include: string[]; exclude: string[]; aliases: string[]; members: string[] }> = [];
  let usedFallback = false;
  try {
    const data = await call(ctx, {
      task: 'synthesize',
      system: synthesizeSystem(ctx.labelLanguage),
      prompt: synthesizePrompt(used.map((c) => ({ key: c.id, name: c.name, parent: c.parent, d: c.definition.slice(0, 120), n: c.count })), g),
      schema: SYNTHESIZE_SCHEMA,
      maxOutputTokens: 800 + used.length * 90,
    });
    const v = validateSynthesis(data, keys, g.maxDepth);
    cats = v.categories;
    if (!cats.length) throw new Error('empty synthesis');
    if (v.report.rejected.length) notes.push(`${v.report.rejected.length} synthesis entries were repaired or rejected during validation.`);
    // Attach uncovered candidates: under the category holding their suggested parent, else as their own category.
    for (const k of v.uncovered) {
      const c = used.find((x) => x.id === k)!;
      const host = c.parent ? cats.find((x) => x.members.includes(c.parent!)) : undefined;
      if (host) host.members.push(k);
      else cats.push({ key: `u_${k}`, name: c.name, parent: null, definition: c.definition, include: [], exclude: [], aliases: [], members: [k] });
    }
    if (v.uncovered.length) notes.push(`${v.uncovered.length} topic(s) the model left out were re-attached automatically.`);
  } catch (e) {
    if (isBudgetOrAbort(e)) throw e;
    usedFallback = true;
    notes.push(`Hierarchy synthesis failed (${(e as Error).message.slice(0, 80)}); built the hierarchy from candidate parents instead.`);
    cats = used.map((c) => ({ key: c.id, name: c.name, parent: c.parent && keys.has(c.parent) ? c.parent : null, definition: c.definition, include: [], exclude: [], aliases: c.aliases, members: [c.id] }));
  }

  // Build the taxonomy (parents before children), skipping invalid entries.
  let t = emptyTaxonomy(opts.id, opts.now, 'discover', g.preset);
  t.granularity = { ...g };
  t.discoveredBy = ctx.provider.id;
  const idFor = new Map<string, string>();
  const countOf = (members: string[]) => members.reduce((n, m) => n + (used.find((c) => c.id === m)?.count ?? 0), 0);
  const subtotal = (key: string): number => {
    const c = cats.find((x) => x.key === key)!;
    return countOf(c.members) + cats.filter((x) => x.parent === key).reduce((n, x) => n + subtotal(x.key), 0);
  };
  const pending = [...cats];
  for (let guard = 0; pending.length && guard < 20; guard++) {
    for (let i = 0; i < pending.length; ) {
      const c = pending[i]!;
      if (c.parent !== null && !idFor.has(c.parent) && cats.some((x) => x.key === c.parent)) {
        i++;
        continue;
      }
      pending.splice(i, 1);
      const parentId = c.parent !== null ? (idFor.get(c.parent) ?? null) : null;
      const memberAliases = c.members.map((m) => used.find((x) => x.id === m)?.name).filter((n): n is string => !!n && foldText(n) !== foldText(c.name));
      const gc = guessConcept({ id: c.key, title: [c.name, ...c.aliases].join(' '), url: '', folderPath: [] }, false);
      try {
        t = applyEdit(t, {
          op: 'add',
          input: {
            name: c.name,
            parentId,
            definition: c.definition,
            include: c.include,
            exclude: c.exclude,
            aliases: [...c.aliases, ...memberAliases],
            conceptKeys: gc.concept ? [gc.concept] : [],
            origin: 'discovered',
            estimatedCount: Math.round(subtotal(c.key) * scale),
            estimate: true,
          },
        }, opts.now);
        idFor.set(c.key, t.categories[t.categories.length - 1]!.id);
      } catch (e) {
        notes.push(`Skipped “${c.name}”: ${(e as Error).message}`);
      }
    }
  }
  notes.push(`Discovered from a ${opts.sampleSize}-bookmark representative sample with ${ctx.provider.id === 'gemini' ? 'Gemini' : 'on-device AI'}; counts are sample-based estimates.`);
  t.notes = notes;
  return { taxonomy: t, usedFallback, notes };
}

/** Errors that must stop the run rather than trigger a fallback. */
function isBudgetOrAbort(e: unknown): boolean {
  if (e instanceof BudgetExceeded) return true;
  return e instanceof ProviderError && (e.kind === 'aborted' || e.kind === 'auth' || e.kind === 'quota');
}

// ───────────────────────── Classification

export interface ClassifyOptions {
  now: number;
  allowNewCategories: boolean;
  /** Restrict categories shown per batch to a shortlist (small context windows). */
  shortlist: boolean;
}

export interface ClassifyBatchResult {
  assignments: Assignment[];
  /** Item ids the model skipped or answered invalidly (retry, then fall back). */
  failed: string[];
  rejected: number;
}

const BAND_ORDER: Record<Band, number> = { low: 0, medium: 1, high: 2 };

export async function classifyBatch(items: readonly ItemInput[], taxonomy: Taxonomy, ctx: AiContext, opts: ClassifyOptions): Promise<ClassifyBatchResult> {
  const rules = new RulesClassifier(taxonomy);
  const act = activeCategories(taxonomy);
  let shown = act;
  if (opts.shortlist) {
    const ids = new Set<string>(act.filter((c) => c.parentId === null).map((c) => c.id));
    for (const it of items) for (const id of rules.shortlist(it, 6)) for (const p of rules.pathIds(id)) ids.add(p);
    shown = act.filter((c) => ids.has(c.id));
  }
  const allowed = new Set(shown.map((c) => c.id));
  const prompts = items.map((it, i) => toPromptItem(it, i, ctx.policy));
  const data = await call(ctx, {
    task: 'classify',
    system: classifySystem(opts.allowNewCategories),
    prompt: classifyPrompt(shown.map((c) => ({ id: c.id, path: pathLabel(taxonomy, c.id), d: c.definition.slice(0, 100) })), prompts),
    schema: classifySchema(opts.allowNewCategories),
    maxOutputTokens: 200 + items.length * 70,
  });
  const { items: valid, report } = validateClassification(data, prompts.map((p) => p.i), allowed, opts.allowNewCategories);
  const out: Assignment[] = [];
  for (const v of valid) {
    const item = items[v.index]!;
    const r = rules.classify(item, opts.now);
    const evidence = [...new Set<EvidenceSource>(['ai', ...(v.evidence as EvidenceSource[])])];
    const a: Assignment = {
      bookmarkId: item.id,
      taxonomyId: taxonomy.id,
      taxonomyVersion: taxonomy.version,
      categoryId: v.categoryId,
      tags: v.tags,
      facets: r.facets,
      rationale: v.why || 'Model gave no rationale.',
      evidence,
      band: v.categoryId ? v.conf : null,
      provider: ctx.provider.id,
      model: ctx.provider.model,
      promptVersion: PROMPT_VERSION,
      inputHash: inputHash(item),
      at: opts.now,
    };
    if (v.categoryId === null) {
      a.needsReview = v.newCat ? 'new-category-suggested' : 'ai-abstained';
      if (v.newCat) a.suggestedCategory = { name: v.newCat.name, parentId: v.newCat.parentId, definition: v.newCat.definition };
      if (r.categoryId) a.competing = [r.categoryId];
    } else {
      const related = r.categoryId && (rules.pathIds(r.categoryId).includes(v.categoryId) || rules.pathIds(v.categoryId).includes(r.categoryId));
      if (r.categoryId && r.band === 'high' && !related) {
        // Strong offline evidence disagrees: don't trust either blindly.
        a.needsReview = 'competing';
        a.competing = [r.categoryId];
        a.band = BAND_ORDER[v.conf] > BAND_ORDER.medium ? 'medium' : v.conf;
      } else if (v.conf === 'low') a.needsReview = 'low-confidence';
    }
    out.push(a);
  }
  return { assignments: out, failed: report.missing.map((i) => items[i]!.id), rejected: report.rejected.length };
}

/** Rules fallback used when AI repeatedly fails for an item. */
export function rulesFallback(item: ItemInput, taxonomy: Taxonomy, now: number, reason: 'ai-invalid' | 'ai-abstained' = 'ai-invalid'): Assignment {
  const a = new RulesClassifier(taxonomy, DEFAULT_THRESHOLDS).classify(item, now);
  return { ...a, needsReview: a.needsReview ?? (a.band === 'high' ? undefined : reason) };
}
