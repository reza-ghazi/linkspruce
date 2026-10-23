/**
 * Inert HTML <head> metadata extraction for audit results.
 *
 * Service workers have no DOMParser, and fetched pages must never be
 * rendered, so this scans a bounded byte prefix with a tag tokenizer. It
 * never executes scripts or loads subresources. Results are untrusted data.
 */
import { decodeEntities, parseAttributes } from '../netscape.ts';

export interface PageMeta {
  title?: string;
  description?: string;
  ogTitle?: string;
  ogSiteName?: string;
  lang?: string;
  /** Raw canonical href as written (unresolved). */
  canonicalHref?: string;
  /** Canonical resolved against base/document URL, validated http(s). */
  canonical?: string;
  baseHref?: string;
  metaRefresh?: string;
  robotsNoindex?: boolean;
  hasPasswordField?: boolean;
  /** Signals that the body is a bot challenge (Cloudflare, captcha...). */
  challenge?: boolean;
  /** Signals the page is a login wall. */
  loginWall?: boolean;
  /** Heuristic soft-404 signal: 200 response whose title/heading says not found. */
  soft404?: boolean;
}

const MAX_TEXT = 300;

function clean(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const t = decodeEntities(s).replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, MAX_TEXT) : undefined;
}

/**
 * Resolve a canonical or base href. Returns undefined for non-http(s)
 * schemes (javascript:, data:, ...) or unparseable values.
 */
export function resolveHttpUrl(href: string, against: string): string | undefined {
  try {
    const u = new URL(href.trim(), against);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    if (u.username || u.password) return undefined;
    return u.href;
  } catch {
    return undefined;
  }
}

const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;

const CHALLENGE_RE =
  /(cf-chl-|challenge-platform|cf_chl_opt|just a moment\.\.\.|attention required! \| cloudflare|captcha|g-recaptcha|h-captcha|hcaptcha|are you a robot|verify you are human|ddos-guard|perimeterx|px-captcha|incapsula)/i;
const LOGIN_TITLE_RE = /\b(sign ?in|log ?in|login|authenticate|single sign-on|sso)\b|ورود|تسجيل الدخول/i;
const SOFT404_RE = /\b(404|page not found|not found|no longer available|does not exist|page doesn['’]t exist|file not found|has been removed)\b|یافت نشد|پیدا نشد/i;

export function extractPageMeta(html: string, documentUrl: string): PageMeta {
  const meta: PageMeta = {};
  let titleStart = -1;
  let firstH1Start = -1;
  let h1Text: string | undefined;
  TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_RE.exec(html))) {
    const closing = m[1] === '/';
    const tag = (m[2] ?? '').toLowerCase();
    const attrsRaw = m[3] ?? '';
    if (titleStart >= 0) {
      if (closing && tag === 'title') {
        meta.title = clean(html.slice(titleStart, m.index));
        titleStart = -1;
      }
      continue;
    }
    if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'template') {
      if (!closing) {
        // Skip raw-text content without interpreting it.
        const end = html.toLowerCase().indexOf(`</${tag}`, TAG_RE.lastIndex);
        TAG_RE.lastIndex = end < 0 ? html.length : end;
      }
      continue;
    }
    if (closing) {
      if (tag === 'h1' && firstH1Start >= 0 && h1Text === undefined) {
        h1Text = clean(html.slice(firstH1Start, m.index).replace(/<[^>]*>/g, ''));
      }
      continue;
    }
    switch (tag) {
      case 'html': {
        const a = parseAttributes(attrsRaw);
        if (a.LANG) meta.lang = a.LANG.slice(0, 20);
        break;
      }
      case 'title':
        if (meta.title === undefined) titleStart = TAG_RE.lastIndex;
        break;
      case 'base': {
        const a = parseAttributes(attrsRaw);
        if (a.HREF && meta.baseHref === undefined) meta.baseHref = a.HREF;
        break;
      }
      case 'link': {
        const a = parseAttributes(attrsRaw);
        const rel = (a.REL ?? '').toLowerCase().split(/\s+/);
        if (rel.includes('canonical') && a.HREF && meta.canonicalHref === undefined) meta.canonicalHref = a.HREF;
        break;
      }
      case 'meta': {
        const a = parseAttributes(attrsRaw);
        const name = (a.NAME ?? a.PROPERTY ?? '').toLowerCase();
        const httpEquiv = (a['HTTP-EQUIV'] ?? '').toLowerCase();
        const content = a.CONTENT;
        if (name === 'description') meta.description ??= clean(content);
        else if (name === 'og:title') meta.ogTitle ??= clean(content);
        else if (name === 'og:site_name') meta.ogSiteName ??= clean(content);
        else if (name === 'robots' && /noindex/i.test(content ?? '')) meta.robotsNoindex = true;
        else if (httpEquiv === 'refresh' && content) meta.metaRefresh = content.slice(0, 500);
        break;
      }
      case 'body':
        break;
      case 'h1':
        if (firstH1Start < 0) firstH1Start = TAG_RE.lastIndex;
        break;
      case 'input': {
        const a = parseAttributes(attrsRaw);
        if ((a.TYPE ?? '').toLowerCase() === 'password') meta.hasPasswordField = true;
        break;
      }
    }
  }
  // Resolve canonical against <base href> (itself resolved against the document URL).
  if (meta.canonicalHref) {
    const base = meta.baseHref ? (resolveHttpUrl(meta.baseHref, documentUrl) ?? documentUrl) : documentUrl;
    const resolved = resolveHttpUrl(decodeEntities(meta.canonicalHref), base);
    if (resolved) meta.canonical = resolved;
  }
  const titleish = `${meta.title ?? ''} ${h1Text ?? ''}`;
  if (CHALLENGE_RE.test(meta.title ?? '') || CHALLENGE_RE.test(html.slice(0, 20000))) meta.challenge = true;
  if (meta.hasPasswordField && LOGIN_TITLE_RE.test(titleish)) meta.loginWall = true;
  else if (LOGIN_TITLE_RE.test(meta.title ?? '') && /\/(login|signin|sign-in|auth|sso|account\/login)/i.test(documentUrl)) {
    meta.loginWall = true;
  }
  if (SOFT404_RE.test(titleish)) meta.soft404 = true;
  return meta;
}
