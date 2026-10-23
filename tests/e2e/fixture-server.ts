/**
 * Controlled local HTTP fixture server for link-audit E2E tests.
 * Hostnames *.linkspruce-fixture.example are mapped to 127.0.0.1 via
 * Chromium's --host-resolver-rules, so audit safety rules (which skip
 * loopback/private hosts) are exercised realistically.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FixtureServer {
  port: number;
  url: (host: string, path: string) => string;
  stats: { total: number; active: number; maxActive: number; perHostActive: Map<string, number>; maxPerHost: number; requests: Array<{ host: string; method: string; path: string; cookie: boolean }> };
  close: () => Promise<void>;
}

const page = (title: string, head = '', body = '') => `<!doctype html><html lang="en"><head><title>${title}</title>${head}</head><body>${body}<p>${'lorem '.repeat(20)}</p></body></html>`;

export async function startFixtureServer(): Promise<FixtureServer> {
  const stats: FixtureServer['stats'] = { total: 0, active: 0, maxActive: 0, perHostActive: new Map(), maxPerHost: 0, requests: [] };
  const hits = new Map<string, number>();
  const server = http.createServer((req, res) => {
    const host = (req.headers.host ?? '').split(':')[0]!;
    const path = req.url ?? '/';
    stats.total++;
    stats.active++;
    stats.maxActive = Math.max(stats.maxActive, stats.active);
    const ph = (stats.perHostActive.get(host) ?? 0) + 1;
    stats.perHostActive.set(host, ph);
    stats.maxPerHost = Math.max(stats.maxPerHost, ph);
    stats.requests.push({ host, method: req.method ?? '', path, cookie: !!req.headers.cookie });
    const done = () => {
      stats.active--;
      stats.perHostActive.set(host, (stats.perHostActive.get(host) ?? 1) - 1);
    };
    res.on('close', done);
    const key = `${host}${path}`;
    const n = (hits.get(key) ?? 0) + 1;
    hits.set(key, n);
    const html = (status: number, body: string, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    const delay = (ms: number, fn: () => void) => setTimeout(fn, ms);
    switch (path.split('?')[0]) {
      case '/ok':
        return delay(150, () => html(200, page('Orbital mechanics fixture page', '<meta name="description" content="Kepler orbits">')));
      case '/head-405':
        if (req.method === 'HEAD') return html(405, '');
        return html(200, page('HEAD not allowed but GET works'));
      case '/notfound':
        return html(404, page('Not Found'));
      case '/gone':
        return html(410, page('Gone'));
      case '/forbidden':
        return html(403, page('Forbidden'));
      case '/unauth':
        return html(401, page('Unauthorized'), { 'www-authenticate': 'Basic realm="x"' });
      case '/ratelimit':
        return n <= 1 ? html(429, page('Too Many Requests'), { 'retry-after': '1' }) : html(200, page('Rate limit passed'));
      case '/error':
        return html(503, page('Service Unavailable'));
      case '/slow':
        return delay(30_000, () => html(200, page('Too slow')));
      case '/redirect':
        res.writeHead(301, { location: '/ok' });
        return res.end();
      case '/private':
        res.writeHead(302, { location: '/login' });
        return res.end();
      case '/login':
        return html(200, page('Sign in', '', '<form><input type="password" name="p"></form>'));
      case '/canonical-a':
        return html(200, page('Article A', '<link rel="canonical" href="/canonical-target">'));
      case '/canonical-b':
        return html(200, page('Article B', '<base href="/x/"><link rel="canonical" href="../canonical-target">'));
      case '/canonical-target':
        return html(200, page('Canonical target'));
      case '/big':
        res.writeHead(200, { 'content-type': 'text/html' });
        if (req.method === 'HEAD') return res.end();
        res.write(page('Big page'));
        for (let i = 0; i < 400 && !res.destroyed; i++) res.write('x'.repeat(16_384));
        return res.end();
      case '/file.pdf':
        res.writeHead(200, { 'content-type': 'application/pdf' });
        return res.end(req.method === 'HEAD' ? undefined : '%PDF-1.4');
      case '/soft404':
        return html(200, page('404 - Page Not Found'));
      case '/challenge':
        return html(403, page('Just a moment...', '', '<div id="cf-chl-widget"></div>'));
      default:
        return delay(200, () => html(200, page(`Fixture ${path}`)));
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    url: (host, path) => `http://${host}.linkspruce-fixture.example:${port}${path}`,
    stats,
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}
