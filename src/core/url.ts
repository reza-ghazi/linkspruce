/**
 * URL analysis: conservative comparison keys, the tracking-parameter policy,
 * audit-eligibility/safety checks, and redaction for logs or cloud prompts.
 *
 * Normalization exists only to compare URLs. Saved bookmark URLs are never
 * rewritten from these values.
 */

/**
 * Tracking parameters removed for the "tracking variant" comparison only.
 * Deliberately small: each entry is a documented advertising/analytics click
 * identifier that does not select content. Generic names such as ref, id,
 * source, page, lang, v or q are NOT included.
 */
export const TRACKING_PARAM_EXACT = new Set([
  'fbclid', // Meta click id
  'gclid', 'dclid', 'gbraid', 'wbraid', 'gclsrc', // Google Ads click ids
  'msclkid', // Microsoft Ads click id
  'yclid', // Yandex click id
  'twclid', // X/Twitter click id
  'ttclid', // TikTok click id
  'li_fat_id', // LinkedIn click id
  'igshid', // Instagram share id
  'mc_cid', 'mc_eid', // Mailchimp campaign/email ids
  '_hsenc', '_hsmi', // HubSpot email tracking
  'srsltid', // Google Merchant result id
  '_gl', // Google cross-domain linker
]);
/** utm_* (Google Analytics campaign tags) are matched by prefix. */
export const TRACKING_PARAM_PREFIXES = ['utm_'];

export function isTrackingParam(name: string): boolean {
  const n = name.toLowerCase();
  return TRACKING_PARAM_EXACT.has(n) || TRACKING_PARAM_PREFIXES.some((p) => n.startsWith(p));
}

export type Transformation =
  | 'lowercase-scheme-host'
  | 'default-port'
  | 'root-path-slash'
  | 'empty-query'
  | 'empty-fragment'
  | 'percent-encoding'
  | 'idn-punycode'
  | 'tracking-params-removed';

export interface UrlKeys {
  original: string;
  /** null when the URL cannot be parsed. */
  parsed: boolean;
  scheme: string;
  host: string;
  /** Structurally equivalent form (no parameter removal). */
  normalized: string;
  /** normalized minus documented tracking parameters. */
  trackingStripped: string;
  transformations: Transformation[];
  removedParams: string[];
}

/** Compute conservative comparison keys for a URL. */
export function urlKeys(original: string): UrlKeys {
  const transformations: Transformation[] = [];
  let u: URL;
  try {
    u = new URL(original);
  } catch {
    return {
      original,
      parsed: false,
      scheme: '',
      host: '',
      normalized: original,
      trackingStripped: original,
      transformations,
      removedParams: [],
    };
  }
  const scheme = u.protocol.replace(/:$/, '');
  if (scheme !== 'http' && scheme !== 'https') {
    return {
      original,
      parsed: true,
      scheme,
      host: u.host,
      normalized: original,
      trackingStripped: original,
      transformations,
      removedParams: [],
    };
  }
  // The URL serializer already lowercases scheme/host, punycodes IDNs, drops
  // default ports and adds "/" to an empty path. Record which ones happened.
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(?:[^@/?#]*@)?([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/.exec(original.trim());
  if (m) {
    const [, rawScheme = '', rawHostPort = '', rawPath = '', rawQuery, rawFrag] = m;
    if (rawScheme !== rawScheme.toLowerCase() || /[A-Z]/.test(rawHostPort.replace(/:\d+$/, ''))) {
      transformations.push('lowercase-scheme-host');
    }
    if (/:(80|443)$/.test(rawHostPort) && u.port === '') transformations.push('default-port');
    if (rawPath === '') transformations.push('root-path-slash');
    if (/[^\x00-\x7f]/.test(rawHostPort)) transformations.push('idn-punycode');
    if (rawQuery === '?') transformations.push('empty-query');
    if (rawFrag === '#') transformations.push('empty-fragment');
    if (rawPath && rawPath !== u.pathname && rawPath !== '') transformations.push('percent-encoding');
  }
  // Serialize without credentials and without empty "?" / "#".
  const base = `${u.protocol}//${u.host}${u.pathname}`;
  const query = u.search === '?' ? '' : u.search;
  const frag = u.hash === '#' ? '' : u.hash;
  const normalized = `${base}${query}${frag}`;

  const removedParams: string[] = [];
  let strippedQuery = query;
  if (query) {
    // Keep the original order and encoding of the remaining parameters.
    const parts = query.slice(1).split('&');
    const kept: string[] = [];
    for (const part of parts) {
      const name = decodeSafe(part.split('=')[0] ?? '');
      if (isTrackingParam(name)) removedParams.push(name);
      else kept.push(part);
    }
    strippedQuery = kept.length ? `?${kept.join('&')}` : '';
  }
  if (removedParams.length) transformations.push('tracking-params-removed');
  return {
    original,
    parsed: true,
    scheme,
    host: u.hostname,
    normalized,
    trackingStripped: `${base}${strippedQuery}${frag}`,
    transformations,
    removedParams,
  };
}

function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
}

export type AuditEligibility =
  | { ok: true }
  | {
      ok: false;
      reason: 'unsupported-scheme' | 'unparseable' | 'embedded-credentials' | 'private-network' | 'sensitive' | 'excluded';
      detail?: string;
    };

const PRIVATE_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa', '.intranet', '.corp', '.test', '.invalid'];

/** True for loopback, link-local, RFC1918, CGNAT, ULA and single-label hosts. */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (h === 'localhost' || h === '0.0.0.0' || PRIVATE_SUFFIXES.some((s) => h.endsWith(s))) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (h.includes(':')) {
    return h === '::1' || h === '::' || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h) || h.startsWith('::ffff:');
  }
  // Single-label names (e.g. "intranet") resolve only on private networks.
  return !h.includes('.');
}

const SENSITIVE_PARAM =
  /^(access_?token|id_?token|refresh_?token|token|auth|authorization|api_?key|apikey|key|secret|client_secret|password|passwd|pwd|pass|session|sessionid|sid|jsessionid|phpsessid|otp|code|ticket|jwt|sig|signature|x-amz-signature|x-amz-credential|x-goog-signature|x-goog-credential|expires|policy|key-pair-id|se|sp|sv|st|skoid|reset_?token|magic|nonce|state|hash)$/i;
const SENSITIVE_PATH =
  /(^|\/)(logout|log-out|signout|sign-out|unsubscribe|delete|remove|destroy|confirm|verify|activate|reset[-_]?password|password[-_]?reset|magic[-_]?link|oauth|authorize|callback|invite|approve|cancel)(\/|$|\?|\.)/i;

export interface SensitivityResult {
  sensitive: boolean;
  reasons: string[];
}

/**
 * Heuristic detection of token-bearing or state-changing URLs. It cannot
 * recognise every sensitive URL; users can add exclusions.
 */
export function detectSensitive(raw: string): SensitivityResult {
  const reasons: string[] = [];
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { sensitive: false, reasons };
  }
  if (u.username || u.password) reasons.push('embedded-credentials');
  for (const [name, value] of u.searchParams) {
    if (SENSITIVE_PARAM.test(name) && value.length >= 6) reasons.push(`param:${name.toLowerCase()}`);
    else if (value.length >= 40 && /^[A-Za-z0-9_\-.~%+/=]+$/.test(value) && /\d/.test(value) && /[A-Za-z]/.test(value)) {
      reasons.push('long-opaque-param');
    }
  }
  if (SENSITIVE_PATH.test(u.pathname)) reasons.push('action-path');
  if (/[#&](access_token|id_token)=/.test(u.hash)) reasons.push('fragment-token');
  return { sensitive: reasons.length > 0, reasons: [...new Set(reasons)] };
}

/** Decide whether a URL may be requested during an online audit. */
export function auditEligibility(raw: string, exclusions: readonly string[] = []): AuditEligibility {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: 'unparseable' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, reason: 'unsupported-scheme', detail: u.protocol.replace(/:$/, '') };
  }
  if (u.username || u.password) return { ok: false, reason: 'embedded-credentials' };
  if (isPrivateHost(u.hostname)) return { ok: false, reason: 'private-network' };
  for (const ex of exclusions) {
    if (matchesExclusion(u, ex)) return { ok: false, reason: 'excluded', detail: ex };
  }
  const s = detectSensitive(raw);
  if (s.sensitive) return { ok: false, reason: 'sensitive', detail: s.reasons.join(',') };
  return { ok: true };
}

/** Exclusion patterns: "example.com" (domain and subdomains) or a URL prefix "https://x.com/path". */
export function matchesExclusion(u: URL, pattern: string): boolean {
  const p = pattern.trim().toLowerCase();
  if (!p) return false;
  if (p.includes('://')) return u.href.toLowerCase().startsWith(p);
  const host = u.hostname.toLowerCase();
  const domain = p.replace(/^\*\./, '');
  return host === domain || host.endsWith(`.${domain}`);
}

const OPAQUE_SEGMENT = /^(?=.*\d)[A-Za-z0-9_-]{16,}$|^[0-9a-f]{8,}(-[0-9a-f]{4,}){2,}$|^\d{6,}$/i;

/**
 * Minimal URL representation for cloud prompts and logs: host + path with
 * opaque/ID-like segments masked; no credentials, query or fragment.
 */
export function redactUrl(raw: string, opts: { keepPath?: boolean } = {}): string {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return `${u.protocol}…`;
    if (opts.keepPath === false) return u.hostname;
    const segs = u.pathname
      .split('/')
      .filter(Boolean)
      .slice(0, 6)
      .map((s) => (OPAQUE_SEGMENT.test(s) ? ':id' : decodeSafe(s).slice(0, 60)));
    return `${u.hostname}${segs.length ? `/${segs.join('/')}` : ''}`;
  } catch {
    return '[unparseable]';
  }
}

/** Registrable-ish domain (last two labels, or three for common 2LD ccTLDs). Heuristic, display/grouping only. */
export function siteOf(hostname: string): string {
  const h = hostname.toLowerCase().replace(/^www\d?\./, '');
  const parts = h.split('.');
  if (parts.length <= 2) return h;
  const sld = parts[parts.length - 2] ?? '';
  const twoLevel = ['co', 'com', 'ac', 'gov', 'edu', 'org', 'net', 'or', 'ne', 'go'];
  if (twoLevel.includes(sld) && (parts[parts.length - 1] ?? '').length === 2) return parts.slice(-3).join('.');
  return parts.slice(-2).join('.');
}
