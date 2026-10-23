/** Scriptable fetch for probe tests (the local HTTP fixture server covers real sockets). */
export interface FakeRoute {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  finalUrl?: string;
  delayMs?: number;
  error?: 'network';
  /** Separate behaviour for HEAD. */
  head?: Omit<FakeRoute, 'head'>;
}

export function makeResponse(url: string, r: FakeRoute): Response {
  const res = new Response(r.body ?? null, { status: r.status ?? 200, headers: r.headers ?? {} });
  const finalUrl = r.finalUrl ?? url;
  Object.defineProperty(res, 'url', { value: finalUrl });
  Object.defineProperty(res, 'redirected', { value: finalUrl !== url });
  return res;
}

export function fakeFetch(routes: Record<string, FakeRoute>) {
  const calls: Array<{ url: string; method: string; credentials?: RequestCredentials }> = [];
  const fn = async (url: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method, credentials: init?.credentials });
    const base = routes[url];
    if (!base) throw new TypeError('Failed to fetch');
    const route = method === 'HEAD' && base.head ? base.head : base;
    if (route.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, route.delayMs);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(t);
          reject(init.signal!.reason ?? new DOMException('Aborted', 'AbortError'));
        });
      });
    }
    if (route.error === 'network') throw new TypeError('Failed to fetch');
    return makeResponse(url, method === 'HEAD' ? { ...route, body: undefined } : route);
  };
  return { fn, calls };
}
