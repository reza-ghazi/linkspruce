/**
 * Feature extraction and a compiled multilingual term matcher.
 *
 * Evidence ladder (weights reflect it):
 *   1. saved title, URL host and path      (strong)
 *   2. existing folder names               (weak, adjustable hint)
 *   3. cached page metadata, if permitted   (moderate)
 *   4. AI inference                        (separate, in ai/)
 */
import { GENERIC_TERMS, GEOGRAPHY_TERMS, PLATFORM_DOMAINS, RESOURCE_TYPES } from '../taxonomy/lexicon.ts';
import { detectScriptLanguage, foldText, isWeakTitle, tokenize, type ScriptLang } from '../text.ts';
import { siteOf } from '../url.ts';

export interface ItemInput {
  id: string;
  title: string;
  url: string;
  folderPath: string[];
  meta?: { title?: string | undefined; description?: string | undefined; ogTitle?: string | undefined; siteName?: string | undefined; lang?: string | undefined } | undefined;
}

export type Channel = 'title' | 'url' | 'domain' | 'folder' | 'metadata';

export interface Features {
  id: string;
  host: string;
  site: string;
  /** Host + path, for path-qualified domain entries ("arxiv.org/list/astro-ph"). */
  hostPath: string;
  platform: boolean;
  weakTitle: boolean;
  lang: ScriptLang;
  tokens: Record<Channel, string[]>;
}

const PATH_NOISE = new Set(['html', 'htm', 'php', 'aspx', 'asp', 'jsp', 'index', 'en', 'fa', 'ar', 'www', 'wiki', 'pages', 'page', 'post', 'posts', 'article', 'articles', 'blob', 'master', 'main', 'tree', 'view', 'details', 'item', 'watch', 'pdf', 'doc', 'docs', 'file', 'files', 'download', 'id']);

export function extractFeatures(item: ItemInput): Features {
  let host = '';
  let path = '';
  try {
    const u = new URL(item.url);
    host = u.hostname.toLowerCase().replace(/^www\d?\./, '');
    path = decodeURIComponentSafe(u.pathname);
  } catch {
    /* unparseable URL: title-only */
  }
  const site = host ? siteOf(host) : '';
  const hostWords = host
    .split('.')
    .slice(0, -1)
    .flatMap((p) => p.split('-'))
    .filter((p) => p.length >= 3 && !['www', 'com', 'org', 'net', 'edu', 'gov', 'co'].includes(p));
  const pathTokens = tokenize(path.replace(/[_\-./+]+/g, ' ')).filter((t) => !PATH_NOISE.has(t) && !/^\d+$/.test(t) && t.length <= 40);
  const metaText = item.meta ? [item.meta.title, item.meta.ogTitle, item.meta.description, item.meta.siteName].filter(Boolean).join(' ') : '';
  return {
    id: item.id,
    host,
    site,
    hostPath: `${host}${path}`.toLowerCase(),
    platform: isPlatform(host),
    weakTitle: isWeakTitle(item.title),
    lang: detectScriptLanguage(item.title || metaText),
    tokens: {
      title: tokenize(item.title),
      url: pathTokens,
      domain: hostWords.map((w) => foldText(w)),
      folder: tokenize(item.folderPath.join(' ')),
      metadata: metaText ? tokenize(metaText) : [],
    },
  };
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function isPlatform(host: string): boolean {
  if (!host) return false;
  for (const d of PLATFORM_DOMAINS) if (host === d || host.endsWith(`.${d}`)) return true;
  return false;
}

export const CHANNEL_WEIGHT: Record<Channel, number> = { title: 1.0, url: 0.6, domain: 0.5, folder: 0.3, metadata: 0.7 };
const PHRASE_BONUS = 1.5;
const GENERIC_FACTOR = 0.45;
export const DOMAIN_PRIOR = 1.6;

export interface VocabEntry {
  key: string;
  terms: string[];
  negative?: string[] | undefined;
  domains?: string[] | undefined;
}

export interface Hit {
  score: number;
  channels: Set<Channel>;
  terms: Set<string>;
  domainHit?: string | undefined;
  negative: number;
}

interface Compiled {
  token: Map<string, Array<{ key: string; term: string; w: number; neg: boolean }>>;
  phrase: Map<string, Array<{ key: string; term: string; rest: string[]; prefixLast: boolean; w: number; neg: boolean }>>;
  prefix: Array<{ key: string; term: string; stem: string; w: number; neg: boolean }>;
  domains: Array<{ key: string; domain: string }>;
}

/** Compile vocabulary entries into lookup tables for fast matching. */
export function compileVocabulary(entries: readonly VocabEntry[]): Compiled {
  const c: Compiled = { token: new Map(), phrase: new Map(), prefix: [], domains: [] };
  const add = (key: string, rawTerm: string, neg: boolean) => {
    const generic = GENERIC_TERMS.has(rawTerm);
    const isPrefix = rawTerm.endsWith('*');
    const term = foldText(isPrefix ? rawTerm.slice(0, -1) : rawTerm);
    if (!term) return;
    const parts = term.split(/[\s]+/).flatMap((p) => tokenize(p, true));
    if (!parts.length) return;
    let w = parts.length > 1 ? PHRASE_BONUS : 1;
    if (generic) w *= GENERIC_FACTOR;
    if (isPrefix && parts.length === 1) {
      c.prefix.push({ key, term: rawTerm, stem: parts[0]!, w, neg });
    } else if (parts.length === 1) {
      const list = c.token.get(parts[0]!) ?? c.token.set(parts[0]!, []).get(parts[0]!)!;
      list.push({ key, term: rawTerm, w, neg });
    } else {
      const list = c.phrase.get(parts[0]!) ?? c.phrase.set(parts[0]!, []).get(parts[0]!)!;
      list.push({ key, term: rawTerm, rest: parts.slice(1), prefixLast: isPrefix, w, neg });
    }
  };
  for (const e of entries) {
    for (const t of e.terms) add(e.key, t, false);
    for (const t of e.negative ?? []) add(e.key, t, true);
    for (const d of e.domains ?? []) c.domains.push({ key: e.key, domain: d.toLowerCase() });
  }
  return c;
}

/** Score every vocabulary key against an item's features. */
/** Maximum total score the folder channel can add to one key (folders are weak hints). */
export const FOLDER_CAP = 0.45;

export function matchVocabulary(
  compiled: Compiled,
  f: Features,
  channels: readonly Channel[] = ['title', 'url', 'domain', 'folder', 'metadata'],
  folderCap = FOLDER_CAP,
): Map<string, Hit> {
  const hits = new Map<string, Hit>();
  const folderCredit = new Map<string, number>();
  const hit = (key: string) => hits.get(key) ?? hits.set(key, { score: 0, channels: new Set(), terms: new Set(), negative: 0 }).get(key)!;
  for (const ch of channels) {
    const toks = f.tokens[ch];
    if (!toks.length) continue;
    const cw = CHANNEL_WEIGHT[ch];
    // Count each (key, term) once per channel.
    const seen = new Set<string>();
    const credit = (key: string, term: string, w: number, neg: boolean) => {
      const sk = `${key}|${term}`;
      if (seen.has(sk)) return;
      seen.add(sk);
      const h = hit(key);
      if (neg) h.negative += w * cw;
      else {
        let add = w * cw;
        if (ch === 'folder') {
          const used = folderCredit.get(key) ?? 0;
          add = Math.max(0, Math.min(add, folderCap - used));
          folderCredit.set(key, used + add);
          if (add === 0) return;
        }
        h.score += add;
        h.channels.add(ch);
        h.terms.add(term);
      }
    };
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i]!;
      for (const e of compiled.token.get(t) ?? []) credit(e.key, e.term, e.w, e.neg);
      for (const e of compiled.phrase.get(t) ?? []) {
        const ok = e.rest.every((r, j) => {
          const tok = toks[i + 1 + j];
          if (tok === undefined) return false;
          return e.prefixLast && j === e.rest.length - 1 ? tok.startsWith(r) : tok === r;
        });
        if (ok) credit(e.key, e.term, e.w, e.neg);
      }
      for (const e of compiled.prefix) {
        if (t.length > e.stem.length && t.startsWith(e.stem)) credit(e.key, e.term, e.w, e.neg);
        else if (t === e.stem) credit(e.key, e.term, e.w, e.neg);
      }
    }
  }
  // Subject-specific domain priors (never for platform hosts).
  if (f.host && !f.platform) {
    for (const d of compiled.domains) {
      const match = d.domain.includes('/') ? f.hostPath.startsWith(d.domain) : f.host === d.domain || f.host.endsWith(`.${d.domain}`);
      if (match) {
        const h = hit(d.key);
        if (!h.domainHit) {
          h.score += DOMAIN_PRIOR;
          h.domainHit = d.domain;
          h.channels.add('domain');
        }
      }
    }
  } else if (f.host && f.platform) {
    // Path-qualified platform entries (e.g. arxiv.org/list/astro-ph) are still allowed.
    for (const d of compiled.domains) {
      if (d.domain.includes('/') && f.hostPath.startsWith(d.domain)) {
        const h = hit(d.key);
        if (!h.domainHit) {
          h.score += DOMAIN_PRIOR;
          h.domainHit = d.domain;
          h.channels.add('domain');
        }
      }
    }
  }
  for (const h of hits.values()) h.score = Math.max(0, h.score - h.negative * 1.2);
  return hits;
}

export interface Facets {
  resourceType?: string | undefined;
  language?: ScriptLang | undefined;
  geography?: string[] | undefined;
}

const RT_COMPILED = compileVocabulary(RESOURCE_TYPES.map((r) => ({ key: r.key, terms: r.terms, domains: r.domains })));
const GEO_COMPILED = compileVocabulary(GEOGRAPHY_TERMS.map((g) => ({ key: g.key, terms: g.terms })));

export function extractFacets(f: Features, url: string): Facets {
  const out: Facets = {};
  // Resource type: domains count even for platforms here (YouTube → video is a format, not a subject).
  let best: { key: string; s: number } | undefined;
  const rtHits = matchVocabulary(RT_COMPILED, { ...f, platform: false }, ['title', 'url', 'metadata']);
  for (const [key, h] of rtHits) if (!best || h.score > best.s) best = { key, s: h.score };
  for (const r of RESOURCE_TYPES) {
    if (r.pathHints?.test(url) && (!best || best.s < 1)) best = { key: r.key, s: 1 };
  }
  if (best && best.s >= 0.9) out.resourceType = best.key;
  out.language = f.lang === 'unknown' ? (/\.ir$/.test(f.host) ? 'fa' : undefined) : f.lang;
  const geo = [...matchVocabulary(GEO_COMPILED, f, ['title', 'metadata']).entries()].filter(([, h]) => h.score >= 0.9).map(([k]) => k);
  if (geo.length) out.geography = geo;
  return out;
}
