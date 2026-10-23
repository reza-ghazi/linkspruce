/**
 * Single-URL health probe: HEAD first, bounded GET fallback, AbortController
 * timeouts, streamed byte limits, and classification into health states.
 *
 * Browser fetch exposes only the final URL and a `redirected` flag. It does
 * not expose intermediate hops or their status codes, and it reports DNS,
 * TLS, connection and CORS failures as the same TypeError. Results never
 * claim more detail than that.
 */
import type { FetchLike } from '../platform.ts';
import { extractPageMeta, type PageMeta } from './html-meta.ts';
import { parseRetryAfter } from './scheduler.ts';

export interface ProbeOptions {
  timeoutMs: number;
  /** Maximum body bytes read for metadata. */
  maxBodyBytes: number;
  /** Read a bounded HTML prefix for title/canonical/challenge signals. */
  wantMeta: boolean;
  signal?: AbortSignal | undefined;
  now?: () => number;
}

export const DEFAULT_PROBE: ProbeOptions = { timeoutMs: 15_000, maxBodyBytes: 256 * 1024, wantMeta: true };

export type ProbeErrorKind = 'timeout' | 'network' | 'aborted';

export interface ProbeResult {
  url: string;
  finalUrl?: string;
  redirected?: boolean;
  status?: number;
  contentType?: string;
  method: 'HEAD' | 'GET';
  usedGetFallback: boolean;
  bytesRead: number;
  truncated: boolean;
  meta?: PageMeta;
  retryAfterMs?: number;
  errorKind?: ProbeErrorKind;
  errorMessage?: string;
  elapsedMs: number;
}

/** Status codes where a HEAD answer is not trusted and GET is retried. */
const HEAD_INCONCLUSIVE = new Set([400, 403, 404, 405, 406, 409, 410, 418, 429, 500, 501, 502, 503]);

const BASE_INIT: RequestInit = {
  credentials: 'omit',
  cache: 'no-store',
  redirect: 'follow',
  referrerPolicy: 'no-referrer',
  mode: 'cors',
};

async function timedFetch(
  fetchFn: FetchLike,
  url: string,
  init: RequestInit,
  opts: ProbeOptions,
): Promise<{ res?: Response; errorKind?: ProbeErrorKind; errorMessage?: string; ctrl: AbortController; clear: () => void }> {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort(new DOMException('Timed out', 'TimeoutError'));
  }, opts.timeoutMs);
  const onOuterAbort = () => ctrl.abort(opts.signal?.reason);
  opts.signal?.addEventListener('abort', onOuterAbort, { once: true });
  const clear = () => {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onOuterAbort);
  };
  try {
    const res = await fetchFn(url, { ...init, signal: ctrl.signal });
    return { res, ctrl, clear };
  } catch (e) {
    clear();
    if (timedOut) return { errorKind: 'timeout', errorMessage: `No response within ${opts.timeoutMs} ms`, ctrl, clear };
    if (opts.signal?.aborted) return { errorKind: 'aborted', errorMessage: 'Cancelled', ctrl, clear };
    const msg = e instanceof Error ? e.message : String(e);
    return { errorKind: 'network', errorMessage: msg.slice(0, 200), ctrl, clear };
  }
}

/** Read at most maxBytes from a body stream, then cancel the rest. */
export async function readBounded(res: Response, maxBytes: number): Promise<{ text: string; bytes: number; truncated: boolean }> {
  if (!res.body) {
    const t = await res.text();
    return { text: t.slice(0, maxBytes), bytes: Math.min(t.length, maxBytes), truncated: t.length > maxBytes };
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  try {
    while (bytes < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const room = maxBytes - bytes;
      if (value.byteLength > room) {
        chunks.push(value.subarray(0, room));
        bytes += room;
        truncated = true;
        break;
      }
      chunks.push(value);
      bytes += value.byteLength;
    }
    if (bytes >= maxBytes) truncated = true;
  } finally {
    reader.cancel().catch(() => undefined);
  }
  const all = new Uint8Array(bytes);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.byteLength;
  }
  return { text: new TextDecoder('utf-8', { fatal: false }).decode(all), bytes, truncated };
}

function isHtml(ct: string | undefined): boolean {
  return !!ct && /text\/html|application\/xhtml\+xml/i.test(ct);
}

export async function probeUrl(fetchFn: FetchLike, url: string, options: Partial<ProbeOptions> = {}): Promise<ProbeResult> {
  const opts: ProbeOptions = { ...DEFAULT_PROBE, ...options };
  const now = opts.now ?? Date.now;
  const t0 = now();
  const base = { url, bytesRead: 0, truncated: false };

  // 1) HEAD probe.
  const head = await timedFetch(fetchFn, url, { ...BASE_INIT, method: 'HEAD' }, opts);
  let needGet = false;
  let headResult: ProbeResult | undefined;
  if (head.res) {
    head.clear();
    const res = head.res;
    res.body?.cancel().catch(() => undefined);
    const ct = res.headers.get('content-type') ?? undefined;
    headResult = {
      ...base,
      method: 'HEAD',
      usedGetFallback: false,
      status: res.status,
      finalUrl: res.url || url,
      redirected: res.redirected,
      contentType: ct,
      elapsedMs: now() - t0,
    };
    const ra = parseRetryAfter(res.headers.get('retry-after'), now());
    if (ra !== undefined) headResult.retryAfterMs = ra;
    if (res.status === 429) return headResult; // respect rate limiting; don't immediately GET
    if (HEAD_INCONCLUSIVE.has(res.status) || res.status === 0) needGet = true;
    else if (opts.wantMeta && res.status >= 200 && res.status < 300 && (isHtml(ct) || !ct)) needGet = true;
  } else if (head.errorKind === 'aborted') {
    return { ...base, method: 'HEAD', usedGetFallback: false, errorKind: 'aborted', errorMessage: head.errorMessage, elapsedMs: now() - t0 };
  } else {
    // Some servers drop or stall HEAD; try a bounded GET once.
    needGet = true;
  }
  if (!needGet && headResult) return headResult;

  // 2) Bounded GET fallback.
  const get = await timedFetch(fetchFn, url, { ...BASE_INIT, method: 'GET', headers: { Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5' } }, opts);
  if (!get.res) {
    // Prefer an inconclusive HEAD answer over a failed GET when we have one.
    if (headResult && headResult.status && headResult.status !== 405 && headResult.status !== 501) {
      return { ...headResult, elapsedMs: now() - t0 };
    }
    return {
      ...base,
      method: 'GET',
      usedGetFallback: true,
      errorKind: get.errorKind ?? head.errorKind ?? 'network',
      errorMessage: get.errorMessage ?? head.errorMessage,
      elapsedMs: now() - t0,
    };
  }
  const res = get.res;
  const ct = res.headers.get('content-type') ?? undefined;
  const result: ProbeResult = {
    ...base,
    method: 'GET',
    usedGetFallback: true,
    status: res.status,
    finalUrl: res.url || url,
    redirected: res.redirected,
    contentType: ct,
    elapsedMs: 0,
  };
  const ra = parseRetryAfter(res.headers.get('retry-after'), now());
  if (ra !== undefined) result.retryAfterMs = ra;
  try {
    if (isHtml(ct) && (opts.wantMeta || res.status === 200 || res.status === 403 || res.status === 401)) {
      const body = await readBounded(res, opts.maxBodyBytes);
      result.bytesRead = body.bytes;
      result.truncated = body.truncated;
      result.meta = extractPageMeta(body.text, result.finalUrl ?? url);
    } else {
      res.body?.cancel().catch(() => undefined);
    }
  } catch (e) {
    // Body read failed (timeout mid-stream): keep the status we have.
    result.errorMessage = e instanceof Error ? e.message.slice(0, 200) : 'Body read failed';
  } finally {
    get.clear();
  }
  result.elapsedMs = now() - t0;
  return result;
}

export type HealthStatus =
  | 'reachable'
  | 'redirected'
  | 'not-found'
  | 'access-restricted'
  | 'rate-limited'
  | 'server-error'
  | 'network-error'
  | 'timeout'
  | 'inconclusive'
  | 'skipped'
  | 'unsupported';

export type Confidence = 'high' | 'medium' | 'low';

export interface HealthVerdict {
  status: HealthStatus;
  confidence: Confidence;
  /** Additional flags, e.g. soft-404-suspected, login-page, bot-challenge. */
  flags: string[];
  retryable: boolean;
  note?: string;
}

export const HEALTH_LABELS: Record<HealthStatus, string> = {
  reachable: 'Reachable',
  redirected: 'Redirected',
  'not-found': 'Not found',
  'access-restricted': 'Access restricted',
  'rate-limited': 'Rate limited',
  'server-error': 'Temporary server error',
  'network-error': 'Network error',
  timeout: 'Timed out',
  inconclusive: 'Inconclusive',
  skipped: 'Skipped',
  unsupported: 'Unsupported',
};

/** Same document after trivial differences (trailing slash, http→https upgrade on same host). */
function isTrivialRedirect(from: string, to: string): boolean {
  try {
    const a = new URL(from);
    const b = new URL(to);
    if (a.href === b.href) return true;
    const strip = (u: URL) => `${u.hostname.replace(/^www\./, '')}${u.pathname.replace(/\/$/, '')}${u.search}`;
    return strip(a) === strip(b);
  } catch {
    return false;
  }
}

export function classifyProbe(p: ProbeResult): HealthVerdict {
  const flags: string[] = [];
  if (p.errorKind === 'timeout') return { status: 'timeout', confidence: 'low', flags, retryable: true, note: p.errorMessage };
  if (p.errorKind === 'aborted') return { status: 'inconclusive', confidence: 'low', flags: ['cancelled'], retryable: true };
  if (p.errorKind === 'network' || p.status === undefined) {
    return {
      status: 'network-error',
      confidence: 'low',
      flags,
      retryable: true,
      note: 'The browser reports DNS, TLS, connection and policy failures identically; this is not proof the link is dead.',
    };
  }
  const s = p.status;
  const meta = p.meta;
  if (meta?.challenge) flags.push('bot-challenge');
  if (meta?.loginWall) flags.push('login-page');
  if (p.redirected && p.finalUrl && !isTrivialRedirect(p.url, p.finalUrl)) flags.push('redirected');
  if (s >= 200 && s < 300) {
    if (meta?.challenge) return { status: 'access-restricted', confidence: 'medium', flags, retryable: false, note: 'Bot challenge page' };
    if (meta?.loginWall) return { status: 'access-restricted', confidence: 'medium', flags, retryable: false, note: 'Login page' };
    if (meta?.soft404) {
      flags.push('soft-404-suspected');
      return { status: 'inconclusive', confidence: 'low', flags, retryable: false, note: 'Page responded but looks like a "not found" page (uncertain).' };
    }
    if (flags.includes('redirected')) return { status: 'redirected', confidence: 'high', flags, retryable: false };
    return { status: 'reachable', confidence: 'high', flags, retryable: false };
  }
  if (s === 404 || s === 410) return { status: 'not-found', confidence: s === 410 ? 'high' : 'medium', flags, retryable: false };
  if (s === 401 || s === 403 || s === 407 || s === 451) {
    return { status: 'access-restricted', confidence: 'medium', flags, retryable: false };
  }
  if (s === 429) return { status: 'rate-limited', confidence: 'medium', flags, retryable: true };
  if (s >= 500) return { status: 'server-error', confidence: 'low', flags, retryable: s === 500 || s === 502 || s === 503 || s === 504 || s === 520 || s === 522 || s === 524 };
  if (s >= 300 && s < 400) return { status: 'redirected', confidence: 'low', flags, retryable: false, note: 'Unfollowed redirect' };
  return { status: 'inconclusive', confidence: 'low', flags, retryable: false, note: `HTTP ${s}` };
}
