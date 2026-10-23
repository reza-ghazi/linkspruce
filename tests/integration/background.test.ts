/**
 * Background orchestration with a protocol-faithful fake Gemini endpoint.
 * These are MOCKED provider tests, not live validation.
 */
import { describe, expect, it } from 'vitest';
import { Background, type Platform } from '../../src/background/app.ts';
import { validateMsg } from '../../src/shared/messages.ts';
import { FakeBookmarks, FakeStore, ManualClock } from '../helpers/fake-chrome.ts';
import { makeResponse } from '../helpers/fake-fetch.ts';
import { seed, testTaxonomy } from '../helpers/fixtures.ts';

type Mode = 'ok' | 'auth';

function fakeGemini(state: { mode: Mode; calls: number }) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    state.calls++;
    if (state.mode === 'auth') return makeResponse(url, { status: 403, body: JSON.stringify({ error: { message: 'Permission denied', status: 'PERMISSION_DENIED' } }) });
    const body = JSON.parse(String(init!.body)) as { input: string; system_instruction: string };
    const indices = [...body.input.matchAll(/\{"i":(\d+),"t":"([^"]*)"/g)].map((m) => ({ i: Number(m[1]), t: m[2]! }));
    let out: unknown;
    if (body.system_instruction.includes('organise discovered subject topics')) {
      const keys = [...body.input.matchAll(/^(k\d+) \|/gm)].map((m) => m[1]!);
      out = { categories: [{ key: 'root', name: 'Science', parent: null, definition: 'Science', members: [] }, ...keys.map((k, n) => ({ key: `c${n}`, name: `Topic ${k}`, parent: 'root', definition: 'x', members: [k] }))] };
    } else if (body.system_instruction.includes('design a personal bookmark taxonomy')) {
      out = { assignments: indices.map((x) => ({ i: x.i, c: /orbit|celestial/i.test(x.t) ? 'n1' : /prime|number/i.test(x.t) ? 'n2' : null })), newCandidates: [{ key: 'n1', name: 'Celestial Mechanics', parent: null, definition: 'Orbits' }, { key: 'n2', name: 'Number Theory', parent: null, definition: 'Primes' }] };
    } else {
      out = { results: indices.map((x) => ({ i: x.i, c: /real estate/i.test(x.t) ? 'cat_realestate' : 'cat_math', conf: 'high', ev: ['title'], why: 'test' })) };
    }
    return makeResponse(url, { status: 200, body: JSON.stringify({ status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: JSON.stringify(out) }] }], usage: { total_input_tokens: 500, total_output_tokens: 100 } }) });
  };
}

async function setup() {
  const bm = new FakeBookmarks();
  await seed(bm);
  const store = new FakeStore();
  const clock = new ManualClock();
  const gem = { mode: 'ok' as Mode, calls: 0 };
  let key: string | undefined;
  const platform: Platform = {
    api: bm,
    store,
    clock,
    fetch: fakeGemini(gem),
    keyStore: { get: async () => key, set: async (k) => void (key = k), clear: async () => void (key = undefined), status: async () => ({ present: !!key, persisted: false }) },
    hasOrigin: async () => true,
    wake: () => undefined,
    languageModel: () => undefined,
    online: () => true,
    appVersion: 'test',
  };
  const make = () => new Background(platform);
  return { bm, store, clock, gem, platform, make, bg: make() };
}

async function drain(bg: Background, rounds = 30) {
  for (let i = 0; i < rounds; i++) {
    await bg.tick();
    const [a, c, d] = await Promise.all([bg.audit.load(), bg.classify.load(), bg.discover.load()]);
    if (![a, c, d].some((j) => j?.status === 'running') && (!d || d.status !== 'completed' || d.options.synthesized)) return;
  }
}

describe('background AI jobs (mocked Gemini)', () => {
  it('requires a key and explicit consent before any cloud request', async () => {
    const { bg, gem, store } = await setup();
    await store.set({ 'taxonomy:current': testTaxonomy() });
    await expect(bg.handle({ type: 'classifyStart', provider: 'gemini', scope: 'all', folderIds: [] })).rejects.toThrow(/not ready \(needs-key\)/);
    await bg.handle({ type: 'geminiKeySet', key: 'AIzaTESTKEY0000000000000000000000000', persist: false });
    await expect(bg.handle({ type: 'classifyStart', provider: 'gemini', scope: 'all', folderIds: [] })).rejects.toThrow(/consent/);
    expect(gem.calls).toBe(0);
    expect(typeof validateMsg({ type: 'geminiKeySet', key: 'short', persist: false })).toBe('string');
  });

  it('classifies in bounded batches, records usage, pauses at the budget and resumes', async () => {
    const { bg, gem, store } = await setup();
    await store.set({ 'taxonomy:current': testTaxonomy() });
    await bg.handle({ type: 'geminiKeySet', key: 'AIzaTESTKEY0000000000000000000000000', persist: false });
    await bg.handle({ type: 'cloudConsent', granted: true });
    await bg.handle({ type: 'updateSettings', patch: { ai: { budget: { maxRequests: 1, maxCostUsd: 5 } } } });
    const p = (await bg.provider('gemini'))!;
    (p as unknown as { cfg: { batchClassify: number } }).cfg.batchClassify = 4;
    bg.classify.opts.batchSize = 4;
    const job = await bg.classify.create(['101', '102', '103', '104', '105', '106', '107', '108', '109', '110', '111'].filter(Boolean), { provider: 'gemini', scope: 'all', ledgerKey: 'classify:t' }, true);
    expect(job.status).toBe('running');
    await drain(bg);
    let st = await bg.classify.load();
    expect(st!.status).toBe('paused');
    expect(st!.pausedReason).toBe('budget-exhausted');
    expect(gem.calls).toBe(1);
    await bg.handle({ type: 'updateSettings', patch: { ai: { budget: { maxRequests: 50 } } } });
    await bg.handle({ type: 'jobControl', job: 'classify', action: 'resume' });
    await drain(bg);
    st = await bg.classify.load();
    expect(st!.status).toBe('completed');
    const all = await bg.repo.assignments.all();
    expect([...all.values()].some((a) => a.provider === 'gemini' && a.model === 'gemini-3.5-flash-lite')).toBe(true);
    const ledger = await bg.repo.ledger('classify:t');
    expect(ledger!.requests).toBe(gem.calls);
    expect(ledger!.estimatedCostUsd).toBeGreaterThan(0);
  });

  it('pauses (does not spin) on authentication errors', async () => {
    const { bg, gem, store } = await setup();
    await store.set({ 'taxonomy:current': testTaxonomy() });
    await bg.handle({ type: 'geminiKeySet', key: 'AIzaTESTKEY0000000000000000000000000', persist: false });
    await bg.handle({ type: 'cloudConsent', granted: true });
    gem.mode = 'auth';
    await bg.handle({ type: 'classifyStart', provider: 'gemini', scope: 'all', folderIds: [] });
    await drain(bg);
    const st = await bg.classify.load();
    expect(st).toMatchObject({ status: 'paused', pausedReason: 'provider-auth' });
    expect(gem.calls).toBe(1);
  });

  it('discovery runs in resumable batches across a worker restart, then synthesizes a draft', async () => {
    const { make, gem } = await setup();
    let bg = make();
    await bg.handle({ type: 'geminiKeySet', key: 'AIzaTESTKEY0000000000000000000000000', persist: false });
    await bg.handle({ type: 'cloudConsent', granted: true });
    await bg.handle({ type: 'updateSettings', patch: { ai: { sampleSize: 50 } } });
    const r = (await bg.handle({ type: 'discoverStart', provider: 'gemini', folderIds: [] })) as { job: { total: number } };
    expect(r.job.total).toBeGreaterThan(0);
    bg = make(); // simulated worker restart before any batch ran
    await drain(bg);
    const draft = await bg.repo.draftTaxonomy();
    expect(draft!.discoveredBy).toBe('gemini');
    expect(draft!.categories.some((c) => c.name.startsWith('Topic'))).toBe(true);
    expect(draft!.categories.every((c) => c.estimate)).toBe(true);
    expect(gem.calls).toBeGreaterThanOrEqual(2);
  });

  it('withdrawing consent switches providers back to offline rules', async () => {
    const { bg } = await setup();
    await bg.handle({ type: 'cloudConsent', granted: true });
    await bg.handle({ type: 'updateSettings', patch: { ai: { provider: 'gemini' }, autoFile: { provider: 'gemini' } } });
    const s = (await bg.handle({ type: 'cloudConsent', granted: false })) as { ai: { provider: string; cloudConsentAt: null }; autoFile: { provider: string } };
    expect(s.ai.provider).toBe('rules');
    expect(s.autoFile.provider).toBe('rules');
    expect(s.ai.cloudConsentAt).toBeNull();
  });

  it('settings messages cannot flip consent or auto-file activation directly', async () => {
    const { bg } = await setup();
    const s = (await bg.handle({ type: 'updateSettings', patch: { ai: { cloudConsentAt: 123 }, autoFile: { enabled: true } } })) as { ai: { cloudConsentAt: number | null }; autoFile: { enabled: boolean } };
    expect(s.ai.cloudConsentAt).toBeNull();
    expect(s.autoFile.enabled).toBe(false);
  });

  it('deleteAllData removes every key including the API key', async () => {
    const { bg, store, platform } = await setup();
    await bg.handle({ type: 'geminiKeySet', key: 'AIzaTESTKEY0000000000000000000000000', persist: false });
    await bg.handle({ type: 'snapshotNow' });
    await bg.handle({ type: 'deleteAllData' });
    expect(await store.keys('')).toEqual([]);
    expect(await platform.keyStore.get()).toBeUndefined();
  });
});

describe("'auto' provider (free on-device AI by default)", () => {
  it('is the default, resolves to on-device AI only when ready, and never to the cloud', async () => {
    const { platform, gem } = await setup();
    const bg = new Background(platform);
    const s = await bg.repo.settings();
    expect(s.ai.provider).toBe('auto');
    expect(s.autoFile.provider).toBe('auto');
    await bg.handle({ type: 'geminiKeySet', key: 'AIzaTESTKEY0000000000000000000000000', persist: false });
    await bg.handle({ type: 'cloudConsent', granted: true });
    expect(await bg.resolveProvider('auto')).toBe('rules'); // no LanguageModel in this platform
    const ready = new Background({ ...platform, languageModel: () => ({ availability: async () => 'available', create: async () => ({ prompt: async () => '{}', destroy: () => undefined }) }) });
    expect(await ready.resolveProvider('auto')).toBe('chrome-ai');
    const downloadable = new Background({ ...platform, languageModel: () => ({ availability: async () => 'downloadable', create: async () => { throw new Error('needs gesture'); } }) });
    expect(await downloadable.resolveProvider('auto')).toBe('rules');
    expect(gem.calls).toBe(0);
  });
});
