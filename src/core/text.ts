/**
 * Multilingual text helpers used for *matching only*. Displayed titles are
 * never rewritten with these functions.
 */

const ARABIC_DIACRITICS = /[ً-ٰٟۖ-ۭ]/g;
const TATWEEL = /ـ/g;
const ZERO_WIDTH = /[​-‍⁠﻿]/g;

/** Fold text for comparison: NFKC, lowercase, unify Arabic/Persian letter variants. */
export function foldText(input: string): string {
  return input
    .normalize('NFKC')
    .replace(ZERO_WIDTH, ' ')
    .replace(TATWEEL, '')
    .replace(ARABIC_DIACRITICS, '')
    .replace(/[يى]/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/[ةۀ]/g, 'ه')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ؤ/g, 'و')
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .toLocaleLowerCase('en-US')
    .replace(/\s+/g, ' ')
    .trim();
}

const STOPWORDS = new Set(
  (
    'a an the and or of for to in on at by with from into is are was be as it its this that these those ' +
    'how what why when where who your you our we my me i vs via about using use new free online best top ' +
    'home page index welcome official site website com org net www html htm php aspx ' +
    'و در به از که را با این آن برای یک تا بر یا هم است های ها می شده شد ' +
    'في من على إلى عن مع هذا هذه ال'
  ).split(/\s+/),
);

/** Split folded text into word tokens (Latin, Arabic-script, digits). */
export function tokenize(input: string, keepStopwords = false): string[] {
  const folded = foldText(input);
  const raw = folded.split(/[^\p{L}\p{N}+#]+/u).filter(Boolean);
  const out: string[] = [];
  for (const t of raw) {
    if (t.length < 2 && !/^[a-z+#]$/.test(t) && !/\p{Script=Arabic}/u.test(t)) continue;
    if (!keepStopwords && STOPWORDS.has(t)) continue;
    out.push(t);
  }
  return out;
}

export type ScriptLang = 'en' | 'fa' | 'ar' | 'mixed' | 'other' | 'unknown';

/** Coarse script-based language guess for a title. Persian vs Arabic uses distinctive letters. */
export function detectScriptLanguage(input: string): ScriptLang {
  let latin = 0;
  let arabicScript = 0;
  let persianMarkers = 0;
  let arabicMarkers = 0;
  let other = 0;
  for (const ch of input) {
    if (/\p{Script=Latin}/u.test(ch)) latin++;
    else if (/\p{Script=Arabic}/u.test(ch)) {
      arabicScript++;
      if ('پچژگکی'.includes(ch)) persianMarkers++;
      if ('ةيكىأإ'.includes(ch)) arabicMarkers++;
    } else if (/\p{L}/u.test(ch)) other++;
  }
  const total = latin + arabicScript + other;
  if (total === 0) return 'unknown';
  const arabicShare = arabicScript / total;
  if (arabicShare > 0.2 && latin / total > 0.2) return 'mixed';
  if (arabicShare > 0.5) return persianMarkers >= arabicMarkers ? 'fa' : 'ar';
  if (latin / total > 0.5) return 'en';
  return 'other';
}

export function isRtl(input: string): boolean {
  const lang = detectScriptLanguage(input);
  return lang === 'fa' || lang === 'ar';
}

const WEAK_TITLES = new Set(
  [
    'home', 'homepage', 'home page', 'index', 'login', 'log in', 'sign in', 'signin', 'sign up', 'welcome',
    'untitled', 'new tab', 'dashboard', 'main page', 'start', 'default', 'loading', 'redirecting', 'page',
    'document', 'error', '404', 'not found', 'access denied', 'just a moment', 'attention required',
    'صفحه اصلی', 'خانه', 'ورود', 'صفحه نخست', 'الرئيسية', 'تسجيل الدخول',
  ].map((s) => foldText(s)),
);

/** True for titles that carry no topical information (Home, Login, Index, empty...). */
export function isWeakTitle(title: string): boolean {
  if (/^\s*(https?|ftp|file):\/\//i.test(title)) return true;
  const f = foldText(title)
    .replace(/[|\-–—:·•]+.*$/, '')
    .trim();
  if (!f) return true;
  if (WEAK_TITLES.has(f)) return true;
  if (/^[\p{N}\p{P}\s]+$/u.test(f)) return true;
  return tokenize(title).length === 0;
}

/** Levenshtein-free cheap similarity on token sets (Jaccard). */
export function jaccard(a: Iterable<string>, b: Iterable<string>): number {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 && sb.size === 0) return 1;
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  return inter / (sa.size + sb.size - inter);
}

/** Small FNV-1a hash → base36, for stable non-cryptographic identifiers. */
export function hashString(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** Slugify a category label into an ASCII-safe id fragment (falls back to hash for non-Latin). */
export function slugify(label: string): string {
  const s = foldText(label)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return s || `c-${hashString(label)}`;
}
