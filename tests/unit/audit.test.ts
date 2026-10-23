import { describe, expect, it } from 'vitest';
import { extractPageMeta } from '../../src/core/audit/html-meta.ts';
import { classifyProbe, probeUrl } from '../../src/core/audit/probe.ts';
import { backoffDelay, parseRetryAfter, RequestScheduler } from '../../src/core/audit/scheduler.ts';
import { fakeFetch } from '../helpers/fake-fetch.ts';

const html = (head: string, body = '') => `<!doctype html><html lang="en"><head>${head}</head><body>${body}</body></html>`;

describe('html metadata extraction (inert)', () => {
  it('resolves relative canonical against base href and document URL', () => {
    const m = extractPageMeta(html('<base href="/docs/"><link rel="canonical" href="guide.html"><title>Guide</title>'), 'https://a.com/x/y');
    expect(m.canonical).toBe('https://a.com/docs/guide.html');
    expect(m.title).toBe('Guide');
    expect(extractPageMeta(html('<link rel=canonical href="../p">'), 'https://a.com/x/y/z').canonical).toBe('https://a.com/x/p');
  });
  it('rejects javascript: and data: canonicals', () => {
    expect(extractPageMeta(html('<link rel="canonical" href="javascript:alert(1)">'), 'https://a.com/').canonical).toBeUndefined();
    expect(extractPageMeta(html('<link rel="canonical" href="data:text/html,x">'), 'https://a.com/').canonical).toBeUndefined();
  });
  it('ignores tags inside scripts and detects challenges/login/soft-404', () => {
    const m = extractPageMeta(html('<script>var s="<link rel=canonical href=https://evil/>";</script><title>Just a moment...</title>'), 'https://a.com/');
    expect(m.canonical).toBeUndefined();
    expect(m.challenge).toBe(true);
    expect(extractPageMeta(html('<title>Sign in</title>', '<form><input type="password"></form>'), 'https://a.com/login').loginWall).toBe(true);
    expect(extractPageMeta(html('<title>Page not found</title>'), 'https://a.com/x').soft404).toBe(true);
  });
  it('treats title text as data (no entity-based injection)', () => {
    const m = extractPageMeta(html('<title>&lt;script&gt;alert(1)&lt;/script&gt;</title>'), 'https://a.com/');
    expect(m.title).toBe('<script>alert(1)</script>');
  });
});

describe('probeUrl', () => {
  it('uses HEAD, then bounded GET for HTML metadata, with credentials omitted', async () => {
    const f = fakeFetch({ 'https://a.com/': { headers: { 'content-type': 'text/html' }, body: html('<title>A</title>') } });
    const p = await probeUrl(f.fn, 'https://a.com/');
    expect(f.calls.map((c) => c.method)).toEqual(['HEAD', 'GET']);
    expect(f.calls.every((c) => c.credentials === 'omit')).toBe(true);
    expect(p.meta?.title).toBe('A');
    expect(classifyProbe(p).status).toBe('reachable');
  });
  it('falls back to GET when HEAD is rejected (405)', async () => {
    const f = fakeFetch({ 'https://a.com/x': { head: { status: 405 }, headers: { 'content-type': 'application/pdf' }, body: 'PDF' } });
    const p = await probeUrl(f.fn, 'https://a.com/x', { wantMeta: false });
    expect(p.usedGetFallback).toBe(true);
    expect(p.status).toBe(200);
    expect(p.meta).toBeUndefined();
  });
  it('skips GET for non-HTML when HEAD succeeds', async () => {
    const f = fakeFetch({ 'https://a.com/f.zip': { headers: { 'content-type': 'application/zip' } } });
    await probeUrl(f.fn, 'https://a.com/f.zip');
    expect(f.calls.map((c) => c.method)).toEqual(['HEAD']);
  });
  it('limits bytes read from oversized responses', async () => {
    const big = html('<title>Big</title>') + 'x'.repeat(2_000_000);
    const f = fakeFetch({ 'https://a.com/big': { headers: { 'content-type': 'text/html' }, body: big } });
    const p = await probeUrl(f.fn, 'https://a.com/big', { maxBodyBytes: 4096 });
    expect(p.bytesRead).toBe(4096);
    expect(p.truncated).toBe(true);
    expect(p.meta?.title).toBe('Big');
  });
  it('times out slow servers', async () => {
    const f = fakeFetch({ 'https://slow.com/': { delayMs: 5000 } });
    const p = await probeUrl(f.fn, 'https://slow.com/', { timeoutMs: 50 });
    expect(p.errorKind).toBe('timeout');
    expect(classifyProbe(p)).toMatchObject({ status: 'timeout', retryable: true, confidence: 'low' });
  });
  it('classifies status codes conservatively', async () => {
    const cases: Array<[number, string]> = [[404, 'not-found'], [410, 'not-found'], [401, 'access-restricted'], [403, 'access-restricted'], [429, 'rate-limited'], [503, 'server-error'], [418, 'inconclusive']];
    for (const [status, expected] of cases) {
      const f = fakeFetch({ 'https://a.com/s': { status, headers: { 'retry-after': '120' } } });
      const p = await probeUrl(f.fn, 'https://a.com/s', { wantMeta: false });
      expect(classifyProbe(p).status, String(status)).toBe(expected);
      if (status === 429) {
        expect(p.retryAfterMs).toBe(120_000);
        expect(f.calls.length).toBe(1); // no GET after 429
      }
    }
  });
  it('reports redirects with only what fetch exposes', async () => {
    const f = fakeFetch({ 'http://a.com/old': { finalUrl: 'https://b.com/new', headers: { 'content-type': 'text/plain' } } });
    const p = await probeUrl(f.fn, 'http://a.com/old');
    expect(p).toMatchObject({ redirected: true, finalUrl: 'https://b.com/new' });
    const v = classifyProbe(p);
    expect(v.status).toBe('redirected');
    expect(f.calls.length).toBe(1);
  });
  it('treats login and challenge pages as access restricted, not dead', async () => {
    const f = fakeFetch({ 'https://a.com/app': { finalUrl: 'https://a.com/login', headers: { 'content-type': 'text/html' }, body: html('<title>Log in</title>', '<input type=password>') } });
    expect(classifyProbe(await probeUrl(f.fn, 'https://a.com/app')).status).toBe('access-restricted');
  });
  it('labels soft-404 pages as uncertain', async () => {
    const f = fakeFetch({ 'https://a.com/gone': { headers: { 'content-type': 'text/html' }, body: html('<title>404 - Page Not Found</title>') } });
    expect(classifyProbe(await probeUrl(f.fn, 'https://a.com/gone'))).toMatchObject({ status: 'inconclusive', flags: expect.arrayContaining(['soft-404-suspected']) });
  });
  it('maps fetch TypeErrors to a non-specific network error', async () => {
    const f = fakeFetch({});
    const v = classifyProbe(await probeUrl(f.fn, 'https://nxdomain.invalid/'));
    expect(v).toMatchObject({ status: 'network-error', confidence: 'low' });
  });
});

describe('RequestScheduler', () => {
  it('enforces global (≤5) and per-origin ceilings', async () => {
    const s = new RequestScheduler({ maxConcurrent: 50, maxPerOrigin: 2, originSpacingMs: 0 });
    expect(s.options.maxConcurrent).toBe(5);
    const work = Array.from({ length: 40 }, (_, i) => s.run(`o${i % 4}`, () => new Promise((r) => setTimeout(r, 5))));
    await Promise.all(work);
    expect(s.peakActive).toBeLessThanOrEqual(5);
    expect(s.peakPerOrigin).toBeLessThanOrEqual(2);
  });
  it('spaces requests to the same origin and honours cooldowns', async () => {
    const s = new RequestScheduler({ maxConcurrent: 5, maxPerOrigin: 1, originSpacingMs: 30 });
    const starts: number[] = [];
    await Promise.all([0, 1, 2].map(() => s.run('o', async () => void starts.push(Date.now()))));
    expect(starts[2]! - starts[0]!).toBeGreaterThanOrEqual(55);
    s.cooldown('c', Date.now() + 80);
    const t0 = Date.now();
    await s.run('c', async () => undefined);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(70);
  });
  it('computes jittered backoff and Retry-After', () => {
    for (let a = 0; a < 6; a++) {
      const d = backoffDelay(a, 1000, 60_000, () => 1);
      expect(d).toBeLessThanOrEqual(Math.min(60_000, 1000 * 2 ** a));
    }
    expect(parseRetryAfter('30', 0)).toBe(30_000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 0)).toBe(10_000);
    expect(parseRetryAfter('99999', 0)).toBe(15 * 60_000);
    expect(parseRetryAfter('soon', 0)).toBeUndefined();
  });
});
