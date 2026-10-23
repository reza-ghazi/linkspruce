import { describe, expect, it } from 'vitest';
import { auditEligibility, detectSensitive, isPrivateHost, redactUrl, urlKeys } from '../../src/core/url.ts';

describe('urlKeys (conservative normalization)', () => {
  it('lowercases scheme/host, drops default port, adds root slash', () => {
    const k = urlKeys('HTTPS://Example.COM:443');
    expect(k.normalized).toBe('https://example.com/');
    expect(k.transformations).toEqual(expect.arrayContaining(['lowercase-scheme-host', 'default-port', 'root-path-slash']));
  });
  it('preserves path case, trailing slash, fragments and parameter order', () => {
    expect(urlKeys('https://a.com/Docs/Page').normalized).not.toBe(urlKeys('https://a.com/docs/page').normalized);
    expect(urlKeys('https://a.com/x/').normalized).not.toBe(urlKeys('https://a.com/x').normalized);
    expect(urlKeys('https://a.com/#/route/a').normalized).not.toBe(urlKeys('https://a.com/#/route/b').normalized);
    expect(urlKeys('https://docs.a.com/p#install').normalized).not.toBe(urlKeys('https://docs.a.com/p#usage').normalized);
    expect(urlKeys('https://a.com/?b=1&a=2').normalized).not.toBe(urlKeys('https://a.com/?a=2&b=1').normalized);
  });
  it('keeps http/https and www/non-www distinct', () => {
    expect(urlKeys('http://a.com/').normalized).not.toBe(urlKeys('https://a.com/').normalized);
    expect(urlKeys('https://www.a.com/').normalized).not.toBe(urlKeys('https://a.com/').normalized);
  });
  it('strips only documented tracking params in the tracking key', () => {
    const k = urlKeys('https://a.com/p?id=7&utm_source=x&ref=home&fbclid=abc&page=2');
    expect(k.trackingStripped).toBe('https://a.com/p?id=7&ref=home&page=2');
    expect(k.normalized).toContain('utm_source');
    expect(k.removedParams).toEqual(['utm_source', 'fbclid']);
  });
  it('never strips meaningful parameters (signed URLs, versions, search, language)', () => {
    const signed = 'https://bucket.s3.amazonaws.com/f.pdf?X-Amz-Signature=abc&X-Amz-Expires=300';
    expect(urlKeys(signed).trackingStripped).toBe(signed);
    for (const q of ['v=2', 'lang=fa', 'q=orbit', 'version=3', 'search=x', 'id=1', 'ref=main']) {
      expect(urlKeys(`https://a.com/?${q}`).trackingStripped).toBe(`https://a.com/?${q}`);
    }
  });
  it('handles unicode hosts and paths', () => {
    const k = urlKeys('https://مثال.إختبار/مسیر');
    expect(k.parsed).toBe(true);
    expect(k.host.startsWith('xn--')).toBe(true);
    expect(k.transformations).toContain('idn-punycode');
  });
  it('treats empty query and empty fragment as equivalent', () => {
    expect(urlKeys('https://a.com/x?').normalized).toBe('https://a.com/x');
    expect(urlKeys('https://a.com/x#').normalized).toBe('https://a.com/x');
  });
  it('leaves non-http schemes and garbage untouched', () => {
    expect(urlKeys('javascript:alert(1)').normalized).toBe('javascript:alert(1)');
    expect(urlKeys('not a url').parsed).toBe(false);
  });
});

describe('audit eligibility & safety', () => {
  it('skips unsupported schemes, credentials and private hosts', () => {
    expect(auditEligibility('ftp://x.org/f')).toMatchObject({ ok: false, reason: 'unsupported-scheme' });
    expect(auditEligibility('https://u:p@x.org/')).toMatchObject({ ok: false, reason: 'embedded-credentials' });
    for (const h of ['localhost', '127.0.0.1', '10.1.2.3', '192.168.0.1', '172.20.1.1', '169.254.1.1', '[::1]', 'router.local', 'nas']) {
      expect(auditEligibility(`http://${h}/`)).toMatchObject({ ok: false, reason: 'private-network' });
    }
    expect(isPrivateHost('8.8.8.8')).toBe(false);
    expect(isPrivateHost('example.com')).toBe(false);
  });
  it('flags token-bearing and action URLs', () => {
    expect(detectSensitive('https://a.com/reset?token=abcdef123456').sensitive).toBe(true);
    expect(detectSensitive('https://a.com/account/logout').sensitive).toBe(true);
    expect(detectSensitive('https://a.com/cb#access_token=xyz').sensitive).toBe(true);
    expect(detectSensitive('https://en.wikipedia.org/wiki/Orbit').sensitive).toBe(false);
  });
  it('honours domain and prefix exclusions', () => {
    expect(auditEligibility('https://sub.bank.com/x', ['bank.com'])).toMatchObject({ ok: false, reason: 'excluded' });
    expect(auditEligibility('https://a.com/private/1', ['https://a.com/private'])).toMatchObject({ ok: false, reason: 'excluded' });
    expect(auditEligibility('https://notbank.com/', ['bank.com'])).toEqual({ ok: true });
  });
  it('redacts queries, fragments and opaque ids', () => {
    expect(redactUrl('https://x.com/users/9f8e7d6c5b4a39281706/doc?token=1#a')).toBe('x.com/users/:id/doc');
    expect(redactUrl('https://x.com/a/b', { keepPath: false })).toBe('x.com');
  });
});
