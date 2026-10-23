/**
 * Background application: orchestration, jobs, privileged network requests
 * and all bookmark mutations. Platform dependencies are injected so the same
 * code runs in the service worker and in Node integration tests.
 */
import { probeUrl, classifyProbe, DEFAULT_PROBE } from '../core/audit/probe.ts';
import { backoffDelay, RequestScheduler } from '../core/audit/scheduler.ts';
import { emptyLedger, estimateRun, BudgetExceeded, type UsageLedger } from '../core/ai/budget.ts';
import { ChromeAiProvider, type LMStatic } from '../core/ai/chrome-ai.ts';
import { GeminiProvider, GEMINI_ORIGIN } from '../core/ai/gemini.ts';
import { classifyBatch, discoveryBatch, newDiscoveryState, rulesFallback, synthesizeTaxonomy, type AiContext, type DiscoveryState } from '../core/ai/pipeline.ts';
import { ProviderError, estimateTokens, type AiProvider, type Availability, type ProviderId } from '../core/ai/types.ts';
import { AutoFiler } from '../core/autofile.ts';
import { SnapshotStore, countSnap, type SnapNode } from '../core/backup.ts';
import { RulesClassifier, type Assignment } from '../core/classify/classifier.ts';
import type { ItemInput } from '../core/classify/features.ts';
import { resolveAssignment, type UserRule } from '../core/classify/precedence.ts';
import { inventory, offlineDraft, parseUserTaxonomy, stratifiedSample, taxonomyFromFolders, type FolderInfo } from '../core/discovery/discovery.ts';
import { JobPause, JobRunner, type JobState, type Outcome } from '../core/jobs.ts';
import { Journal, recreateSteps, type BatchHeader } from '../core/journal.ts';
import type { BmNode, BookmarksApi, Clock, FetchLike, KeyValueStore } from '../core/platform.ts';
import { buildOrganizePlan, dedupeSteps, folderMapFromResults, planIsCurrent, planToSteps } from '../core/plan.ts';
import { Repo, type HealthRecord } from '../core/repo.ts';
import { updateSettings, type Settings } from '../core/settings.ts';
import { getChunked, newId, removeChunked } from '../core/store.ts';
import { applyEdit, freeze, GRANULARITY, unfreeze, type Taxonomy } from '../core/taxonomy/taxonomy.ts';
import { flattenTree, discoverRoots, isWithin, type FlatTree } from '../core/tree.ts';
import { auditEligibility } from '../core/url.ts';
import type { Msg } from '../shared/messages.ts';

export interface Platform {
  api: BookmarksApi;
  store: KeyValueStore;
  clock: Clock;
  fetch: FetchLike;
  keyStore: { get(): Promise<string | undefined>; set(key: string, persist: boolean): Promise<void>; clear(): Promise<void>; status(): Promise<{ present: boolean; persisted: boolean }> };
  hasOrigin: (originPattern: string) => Promise<boolean>;
  /** Ensure a wake-up alarm exists (or clear it). */
  wake: (atMs: number | null) => void;
  languageModel: () => LMStatic | undefined;
  online: () => boolean;
  appVersion: string;
}

type AuditOpts = { mode: 'stale' | 'all' };
type ClassifyOpts = { provider: ProviderId; scope: 'uncertain' | 'all'; ledgerKey: string };
type DiscoverOpts = { provider: ProviderId; ledgerKey: string; selectedTotal: number; sampleSize: number; synthesized: boolean };

export class Background {
  readonly p: Platform;
  readonly repo: Repo;
  readonly journal: Journal;
  readonly snapshots: SnapshotStore;
  readonly scheduler = new RequestScheduler();
  readonly audit: JobRunner<AuditOpts>;
  readonly classify: JobRunner<ClassifyOpts>;
  readonly discover: JobRunner<DiscoverOpts>;
  readonly autofile: AutoFiler;
  private recovered: Promise<void> | null = null;
  private originPermCache = new Map<string, { ok: boolean; at: number }>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(p: Platform) {
    this.p = p;
    this.repo = new Repo(p.store, p.clock);
    this.journal = new Journal(p.store, p.api, p.clock);
    this.snapshots = new SnapshotStore(p.store, p.clock);
    this.audit = new JobRunner<AuditOpts>('audit', p.store, p.clock, (ids, ctx) => this.processAudit(ids, ctx.attempts, ctx.signal), { batchSize: 1, concurrency: 4, leaseMs: 60_000, maxAttempts: 3 });
    this.classify = new JobRunner<ClassifyOpts>('classify', p.store, p.clock, (ids, ctx) => this.processClassify(ids, ctx.job, ctx.attempts, ctx.signal), { batchSize: 40, concurrency: 1, leaseMs: 120_000, maxAttempts: 3 });
    this.discover = new JobRunner<DiscoverOpts>('discover', p.store, p.clock, (ids, ctx) => this.processDiscover(ids, ctx.job, ctx.signal), { batchSize: 60, concurrency: 1, leaseMs: 120_000, maxAttempts: 3 });
    this.autofile = new AutoFiler({
      repo: this.repo,
      api: p.api,
      journal: this.journal,
      clock: p.clock,
      snapshots: this.snapshots,
      provider: (id) => this.provider(id),
      fetchMeta: (url) => this.fetchMeta(url),
      schedule: (at) => this.scheduleTick(at),
    });
  }

  // ───────────────────────── lifecycle

  /** Once per worker life: reconcile interrupted journal batches and expired job leases. */
  ensureRecovered(): Promise<void> {
    if (!this.recovered) {
      this.recovered = (async () => {
        await this.journal.recover().catch(() => undefined);
        await this.armWake();
      })();
    }
    return this.recovered;
  }

  /** Alarm/startup entry: advance every job a bounded amount. */
  async tick(): Promise<void> {
    await this.ensureRecovered();
    const s = await this.repo.settings();
    this.scheduler.configure({ maxConcurrent: s.audit.maxConcurrent, maxPerOrigin: s.audit.maxPerOrigin, originSpacingMs: s.audit.originSpacingMs });
    // Auto-resume jobs paused only because the browser was offline.
    for (const r of [this.audit, this.classify, this.discover] as JobRunner<unknown>[]) {
      const st = await r.load();
      if (st?.status === 'paused' && st.pausedReason === 'offline' && this.p.online()) await r.resume();
    }
    await Promise.all([this.autofile.tick().catch(() => undefined), this.audit.run(), this.classify.run(), this.runDiscovery()]);
    await this.armWake();
  }

  private scheduleTick(at: number): void {
    const delay = Math.max(0, at - this.p.clock.now());
    // While the worker is alive a timer gives prompt settling; the alarm covers termination.
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, Math.min(delay + 50, 25_000));
    this.p.wake(at);
  }

  /** Keep a wake-up alarm while anything is pending; clear it when idle. */
  async armWake(): Promise<void> {
    const times: number[] = [];
    for (const r of [this.audit, this.classify, this.discover] as JobRunner<unknown>[]) {
      const st = await r.load();
      if (st) {
        const t = r.nextWakeAt(st);
        if (t !== undefined) times.push(t);
      }
    }
    const disc = await this.discover.load();
    if (disc?.status === 'completed' && !disc.options.synthesized) times.push(this.p.clock.now());
    const q = await this.autofile.queue();
    for (const it of Object.values(q)) if (it.status === 'settling' || it.status === 'retry') times.push(it.dueAt);
    if ((await this.journal.index()).some((h) => h.status === 'running')) times.push(this.p.clock.now());
    const next = times.length ? Math.min(...times) : null;
    this.p.wake(next);
    // Alarms have a 30 s minimum; while this worker is alive, a timer handles nearer wake-ups.
    if (next !== null && next - this.p.clock.now() < 25_000 && !this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.tick();
      }, Math.max(50, next - this.p.clock.now() + 50));
    }
  }

  // ───────────────────────── providers

  /** Resolve 'auto' to the free on-device model if Chrome reports it ready, else offline rules. Never cloud. */
  async resolveProvider(id: ProviderId): Promise<Exclude<ProviderId, 'auto'>> {
    if (id !== 'auto') return id;
    const av = await new ChromeAiProvider(this.p.languageModel).availability();
    return av.state === 'available' ? 'chrome-ai' : 'rules';
  }

  async provider(id: ProviderId): Promise<AiProvider | null> {
    id = await this.resolveProvider(id);
    if (id === 'rules') return null;
    if (id === 'chrome-ai') return new ChromeAiProvider(this.p.languageModel);
    const s = await this.repo.settings();
    return new GeminiProvider(this.p.fetch, () => this.p.keyStore.get(), { model: s.ai.gemini.model, apiStyle: s.ai.gemini.apiStyle }, () => this.p.hasOrigin(GEMINI_ORIGIN));
  }

  async aiAvailability(): Promise<Record<'chrome-ai' | 'gemini', Availability>> {
    const s = await this.repo.settings();
    const chromeAi = await new ChromeAiProvider(this.p.languageModel).availability();
    let gemini = await (await this.provider('gemini'))!.availability();
    if (gemini.state === 'available' && !s.ai.cloudConsentAt) gemini = { state: 'needs-consent' };
    return { 'chrome-ai': chromeAi, gemini };
  }

  private async aiContext(provider: AiProvider, s: Settings, ledgerKey: string, signal?: AbortSignal): Promise<AiContext> {
    if (provider.kind === 'cloud' && !s.ai.cloudConsentAt) throw new JobPause('needs-consent');
    const ledger: UsageLedger = (await this.repo.ledger(ledgerKey)) ?? emptyLedger(this.p.clock.now());
    return { provider, budget: s.ai.budget, ledger, policy: s.ai.dataPolicy, labelLanguage: s.labelLanguage, signal, onUsage: (l) => this.repo.saveLedger(ledgerKey, l) };
  }

  /** Map provider/budget errors to job outcomes: pause for user-fixable conditions. */
  private aiErrorToPause(e: unknown): never {
    if (e instanceof BudgetExceeded) throw new JobPause('budget-exhausted');
    if (e instanceof ProviderError) {
      if (e.kind === 'auth') throw new JobPause('provider-auth');
      if (e.kind === 'quota') throw new JobPause('provider-quota');
      if (e.kind === 'unavailable' || e.kind === 'model-not-found' || e.kind === 'invalid-request' || e.kind === 'blocked') throw new JobPause(`provider-${e.kind}`);
      if (e.kind === 'network' && !this.p.online()) throw new JobPause('offline');
    }
    throw e;
  }

  // ───────────────────────── data helpers

  private clfCache: { key: string; clf: RulesClassifier } | null = null;

  /** Offline classifier compiled once per taxonomy version. */
  rulesFor(t: Taxonomy): RulesClassifier {
    const key = `${t.id}:${t.version}`;
    if (this.clfCache?.key !== key) this.clfCache = { key, clf: new RulesClassifier(t) };
    return this.clfCache.clf;
  }

  private treeCache: { root: BmNode; flat: FlatTree; at: number } | null = null;

  /** Drop the cached tree (called on every bookmark event). */
  invalidateTree(): void {
    this.treeCache = null;
  }

  /**
   * Current bookmark tree. Cached briefly for read-only bulk work (classification
   * batches); mutations always re-read nodes and check expected state themselves.
   */
  async tree(maxAgeMs = 0): Promise<{ root: BmNode; flat: FlatTree }> {
    const now = this.p.clock.now();
    if (maxAgeMs > 0 && this.treeCache && now - this.treeCache.at <= maxAgeMs) return this.treeCache;
    const [root] = await this.p.api.getTree();
    this.treeCache = { root: root!, flat: flattenTree(root!), at: now };
    return this.treeCache;
  }

  private itemFor(b: { id: string; title: string; url: string; path: string[] }, health?: HealthRecord, includeMeta = false): ItemInput {
    const it: ItemInput = { id: b.id, title: b.title, url: b.url, folderPath: b.path };
    if (includeMeta && health?.meta) it.meta = { title: health.meta.title, description: health.meta.description, ogTitle: health.meta.ogTitle, siteName: health.meta.ogSiteName };
    return it;
  }

  private scopeFilter(flat: FlatTree, folderIds: string[]): (id: string) => boolean {
    if (!folderIds.length) return () => true;
    const set = new Set(folderIds);
    return (id) => isWithin(flat, id, set);
  }

  // ───────────────────────── audits

  async startAudit(mode: 'stale' | 'all', folderIds: string[], ids: string[]): Promise<JobState<AuditOpts>> {
    const s = await this.repo.settings();
    const { flat } = await this.tree();
    const inScope = this.scopeFilter(flat, folderIds);
    let targets = ids.length ? ids.filter((id) => flat.byId.has(id)) : flat.bookmarks.filter((b) => inScope(b.id)).map((b) => b.id);
    if (mode === 'stale' && !ids.length) {
      const fresh = s.audit.freshnessDays * 86_400_000;
      const now = this.p.clock.now();
      const recs = await this.repo.health.getMany(targets);
      targets = targets.filter((id) => {
        const r = recs.get(id);
        const url = (flat.byId.get(id) as { url?: string } | undefined)?.url;
        return !r || r.url !== url || now - r.checkedAt > fresh || ['timeout', 'network-error', 'server-error', 'rate-limited', 'inconclusive'].includes(r.status) || (r.status === 'not-found' && !r.notFoundConfirmedAt);
      });
    }
    const st = await this.audit.create(targets, { mode });
    void this.tick();
    return st;
  }

  private async originAllowed(url: string): Promise<boolean> {
    let pattern: string;
    try {
      const u = new URL(url);
      pattern = `${u.protocol}//${u.hostname}/*`;
    } catch {
      return false;
    }
    const c = this.originPermCache.get(pattern);
    if (c && this.p.clock.now() - c.at < 60_000) return c.ok;
    const ok = await this.p.hasOrigin(pattern);
    this.originPermCache.set(pattern, { ok, at: this.p.clock.now() });
    return ok;
  }

  invalidatePermissionCache(): void {
    this.originPermCache.clear();
  }

  private async processAudit(ids: string[], attempts: Record<string, number>, signal: AbortSignal): Promise<Outcome[]> {
    const s = await this.repo.settings();
    const out: Outcome[] = [];
    for (const id of ids) {
      const node = (await this.p.api.get(id).catch(() => [] as BmNode[]))[0];
      if (!node?.url) {
        out.push({ id, kind: 'skipped', reason: 'removed' });
        continue;
      }
      const now = this.p.clock.now();
      const prev = await this.repo.health.get(id);
      const elig = auditEligibility(node.url, s.audit.exclusions);
      if (!elig.ok && (elig.reason !== 'sensitive' || s.audit.skipSensitive)) {
        await this.repo.health.set(id, { url: node.url, status: elig.reason === 'unsupported-scheme' || elig.reason === 'unparseable' ? 'unsupported' : 'skipped', confidence: 'high', flags: [], checkedAt: now, attempts: 0, skipReason: elig.reason });
        out.push({ id, kind: 'skipped', reason: elig.reason });
        continue;
      }
      if (!this.p.online()) throw new JobPause('offline');
      if (!(await this.originAllowed(node.url))) {
        await this.repo.health.set(id, { url: node.url, status: 'skipped', confidence: 'high', flags: [], checkedAt: now, attempts: 0, skipReason: 'no-permission' });
        out.push({ id, kind: 'skipped', reason: 'no-permission' });
        continue;
      }
      const origin = new URL(node.url).origin;
      const probe = await this.scheduler.run(origin, () => probeUrl(this.p.fetch, node.url!, { ...DEFAULT_PROBE, timeoutMs: s.audit.timeoutMs, wantMeta: s.audit.fetchMetadata, signal }), signal);
      if (probe.errorKind === 'aborted') return out;
      const v = classifyProbe(probe);
      const attempt = attempts[id] ?? 1;
      if (probe.retryAfterMs !== undefined) this.scheduler.cooldown(origin, this.p.clock.now() + probe.retryAfterMs);
      const rec: HealthRecord = {
        url: node.url,
        status: v.status,
        confidence: v.confidence,
        flags: v.flags,
        httpStatus: probe.status,
        finalUrl: probe.finalUrl,
        redirected: probe.redirected,
        checkedAt: this.p.clock.now(),
        attempts: attempt,
        note: v.note,
      };
      if (probe.meta) rec.meta = { title: probe.meta.title, description: probe.meta.description, canonical: probe.meta.canonical, lang: probe.meta.lang, ogTitle: probe.meta.ogTitle, ogSiteName: probe.meta.ogSiteName };
      if (v.status === 'not-found') {
        const first = prev?.status === 'not-found' && prev.url === node.url ? (prev.notFoundFirstAt ?? prev.checkedAt) : rec.checkedAt;
        rec.notFoundFirstAt = first;
        if (rec.checkedAt - first >= s.audit.notFoundRecheckMinutes * 60_000) rec.notFoundConfirmedAt = rec.checkedAt;
      }
      await this.repo.health.set(id, rec);
      if (v.retryable && attempt < s.audit.maxAttempts) {
        const delay = Math.max(backoffDelay(attempt), probe.retryAfterMs ?? 0);
        out.push({ id, kind: 'retry', retryAt: this.p.clock.now() + delay, error: v.status });
      } else out.push({ id, kind: 'done' });
    }
    return out;
  }

  private async fetchMeta(url: string) {
    if (!auditEligibility(url).ok || !(await this.originAllowed(url))) return undefined;
    const origin = new URL(url).origin;
    const p = await this.scheduler.run(origin, () => probeUrl(this.p.fetch, url, { ...DEFAULT_PROBE, timeoutMs: 10_000, maxBodyBytes: 128 * 1024 }));
    return p.meta;
  }

  // ───────────────────────── taxonomy discovery

  private async folderInfos(flat: FlatTree): Promise<FolderInfo[]> {
    const kids = new Map<string, string[]>();
    for (const b of flat.bookmarks) (kids.get(b.parentId) ?? kids.set(b.parentId, []).get(b.parentId)!).push(b.id);
    return flat.folders.map((f) => ({ id: f.id, title: f.title, path: f.path, bookmarkIds: kids.get(f.id) ?? [] }));
  }

  private async selectedItems(folderIds: string[], forAi: boolean): Promise<{ items: ItemInput[]; flat: FlatTree; s: Settings }> {
    const s = await this.repo.settings();
    const { flat } = await this.tree();
    const inScope = this.scopeFilter(flat, folderIds);
    const prot = new Set([...s.protectedFolderIds, ...(forAi ? s.aiExcludedFolderIds : [])]);
    const healths = s.ai.dataPolicy.includeMetadata ? await this.repo.health.all() : new Map<string, HealthRecord>();
    const items = flat.bookmarks
      .filter((b) => b.writable && inScope(b.id) && !isWithin(flat, b.id, prot))
      .map((b) => this.itemFor(b, healths.get(b.id), s.ai.dataPolicy.includeMetadata));
    return { items, flat, s };
  }

  /** Start discovery: rules → immediate draft; AI → sampled, resumable job + synthesis. */
  async startDiscovery(requested: ProviderId, folderIds: string[]): Promise<{ draft?: Taxonomy; job?: JobState<DiscoverOpts> }> {
    const provider = await this.resolveProvider(requested);
    const { items, s } = await this.selectedItems(folderIds, provider !== 'rules');
    const inv = inventory(items, this.p.clock.now);
    if (provider === 'rules') {
      const { taxonomy } = offlineDraft(inv, newId('tax_'), this.p.clock.now(), s.granularity, s.taxonomyMode);
      taxonomy.labelLanguage = s.labelLanguage;
      await this.repo.saveDraftTaxonomy(taxonomy);
      return { draft: taxonomy };
    }
    const prov = await this.provider(provider);
    const av = await prov!.availability();
    if (av.state !== 'available') throw new Error(`The ${provider === 'gemini' ? 'Gemini' : 'on-device'} provider is not ready (${av.state}).`);
    if (prov!.kind === 'cloud' && !s.ai.cloudConsentAt) throw new Error('Cloud processing needs your consent first (Settings & Privacy).');
    const size = prov!.kind === 'cloud' ? s.ai.sampleSize : Math.min(s.ai.sampleSize, 360);
    const sample = stratifiedSample(items, inv, { size, seed: 20261022, minPerStratum: 3 });
    await this.p.store.set({ 'discovery:state': newDiscoveryState(), 'discovery:items': Object.fromEntries(sample.map((x) => [x.id, x])) });
    const ledgerKey = `discover:${newId('')}`;
    this.discover.opts.batchSize = prov!.batch.discover;
    const job = await this.discover.create(sample.map((x) => x.id), { provider, ledgerKey, selectedTotal: items.length, sampleSize: sample.length, synthesized: false }, true);
    void this.tick();
    return { job };
  }

  private async processDiscover(ids: string[], job: Readonly<JobState<DiscoverOpts>>, signal: AbortSignal): Promise<Outcome[]> {
    const s = await this.repo.settings();
    const prov = await this.provider(job.options.provider);
    if (!prov) return ids.map((id) => ({ id, kind: 'skipped' as const }));
    const itemsMap = (await this.p.store.get<Record<string, ItemInput>>('discovery:items')) ?? {};
    const items = ids.map((id) => itemsMap[id]).filter((x): x is ItemInput => !!x);
    const state = (await this.p.store.get<DiscoveryState>('discovery:state')) ?? newDiscoveryState();
    try {
      const ctx = await this.aiContext(prov, s, job.options.ledgerKey, signal);
      const next = await discoveryBatch(state, items, ctx);
      await this.p.store.set({ 'discovery:state': next });
    } catch (e) {
      if (e instanceof JobPause) throw e;
      this.aiErrorToPause(e);
    }
    return ids.map((id) => ({ id, kind: 'done' as const }));
  }

  /** After the batch job completes, synthesize the hierarchy once. */
  private async runDiscovery(): Promise<void> {
    await this.discover.run();
    const job = await this.discover.load();
    if (!job || job.status !== 'completed' || job.options.synthesized) return;
    const s = await this.repo.settings();
    const prov = await this.provider(job.options.provider);
    const state = (await this.p.store.get<DiscoveryState>('discovery:state')) ?? newDiscoveryState();
    const markDone = async (extra: Partial<DiscoverOpts>, err?: string) => {
      const latest = (await this.discover.load())!;
      latest.options = { ...latest.options, synthesized: true, ...extra };
      if (err) latest.lastError = err;
      await this.p.store.set({ 'job:discover': latest });
    };
    if (!prov || !state.candidates.length) {
      await markDone({}, 'No topics were discovered; try the offline draft.');
      return;
    }
    try {
      const ctx = await this.aiContext(prov, s, job.options.ledgerKey);
      const { taxonomy } = await synthesizeTaxonomy(state, ctx, { ...(await this.granularity()) }, { id: newId('tax_'), now: this.p.clock.now(), sampleSize: job.options.sampleSize, selectedTotal: job.options.selectedTotal });
      taxonomy.labelLanguage = s.labelLanguage;
      await this.repo.saveDraftTaxonomy(taxonomy);
      await markDone({});
    } catch (e) {
      await markDone({}, `Synthesis failed: ${(e as Error).message}`);
    }
  }

  private async granularity() {
    const s = await this.repo.settings();
    return GRANULARITY[s.granularity];
  }

  // ───────────────────────── classification

  async startClassification(requested: ProviderId, scope: 'uncertain' | 'all', folderIds: string[]): Promise<JobState<ClassifyOpts>> {
    const provider = await this.resolveProvider(requested);
    const t = await this.repo.taxonomy();
    if (!t) throw new Error('Approve a taxonomy first.');
    const { items, s } = await this.selectedItems(folderIds, false);
    let ids = items.map((i) => i.id);
    if (provider !== 'rules') {
      const prov = await this.provider(provider);
      const av = await prov!.availability();
      if (av.state !== 'available') throw new Error(`The ${provider === 'gemini' ? 'Gemini' : 'on-device'} provider is not ready (${av.state}).`);
      if (prov!.kind === 'cloud' && !s.ai.cloudConsentAt) throw new Error('Cloud processing needs your consent first.');
      this.classify.opts.batchSize = prov!.batch.classify;
      if (scope === 'uncertain') {
        const clf = new RulesClassifier(t);
        const now = this.p.clock.now();
        ids = items.filter((it) => clf.classify(it, now).band !== 'high').map((i) => i.id);
      }
    } else this.classify.opts.batchSize = 5000; // local and fast; fewer batches = fewer shard rewrites
    const job = await this.classify.create(ids, { provider, scope, ledgerKey: `classify:${newId('')}` }, true);
    void this.tick();
    return job;
  }

  private async processClassify(ids: string[], job: Readonly<JobState<ClassifyOpts>>, attempts: Record<string, number>, signal: AbortSignal): Promise<Outcome[]> {
    const s = await this.repo.settings();
    const t = await this.repo.taxonomy();
    if (!t) throw new JobPause('no-taxonomy');
    const { flat } = await this.tree(30_000);
    const healths = s.ai.dataPolicy.includeMetadata ? await this.repo.health.getMany(ids) : new Map<string, HealthRecord>();
    const aiExcluded = new Set(s.aiExcludedFolderIds);
    const items: ItemInput[] = [];
    const out: Outcome[] = [];
    const localOnly: ItemInput[] = [];
    for (const id of ids) {
      const b = flat.byId.get(id);
      if (!b || !('url' in b)) {
        out.push({ id, kind: 'skipped', reason: 'removed' });
        continue;
      }
      const it = this.itemFor(b, healths.get(id), s.ai.dataPolicy.includeMetadata);
      if (job.options.provider !== 'rules' && isWithin(flat, id, aiExcluded)) localOnly.push(it);
      else items.push(it);
    }
    const now = this.p.clock.now();
    const save: Array<[string, Assignment]> = [];
    const clf = this.rulesFor(t);
    for (const it of localOnly) save.push([it.id, clf.classify(it, now)]);
    if (job.options.provider === 'rules') {
      for (const it of items) save.push([it.id, clf.classify(it, now)]);
      await this.repo.assignments.setMany(save);
      return [...out, ...items.map((i) => ({ id: i.id, kind: 'done' as const })), ...localOnly.map((i) => ({ id: i.id, kind: 'done' as const }))];
    }
    const prov = (await this.provider(job.options.provider))!;
    try {
      const ctx = await this.aiContext(prov, s, job.options.ledgerKey, signal);
      const res = await classifyBatch(items, t, ctx, { now, allowNewCategories: false, shortlist: prov.kind === 'on-device' });
      for (const a of res.assignments) save.push([a.bookmarkId, a]);
      for (const a of res.assignments) out.push({ id: a.bookmarkId, kind: 'done' });
      for (const id of res.failed) {
        if ((attempts[id] ?? 1) >= 2) {
          const it = items.find((x) => x.id === id)!;
          save.push([id, rulesFallback(it, t, now)]);
          out.push({ id, kind: 'done' });
        } else out.push({ id, kind: 'retry', retryAt: now + 2000, error: 'AI skipped or answered invalidly' });
      }
    } catch (e) {
      if (e instanceof JobPause) throw e;
      if (e instanceof ProviderError && e.kind === 'context-overflow') {
        // Halve the batch next time and retry these items.
        this.classify.opts.batchSize = Math.max(3, Math.floor(this.classify.opts.batchSize / 2));
        return [...out, ...items.map((i) => ({ id: i.id, kind: 'retry' as const, retryAt: now, error: 'context overflow' }))];
      }
      if (e instanceof ProviderError && e.retryable) {
        const at = now + Math.max(e.retryAfterMs ?? 0, backoffDelay(attempts[items[0]?.id ?? ''] ?? 1, 5000));
        await this.repo.assignments.setMany(save);
        return [...out, ...items.map((i) => ({ id: i.id, kind: 'retry' as const, retryAt: at, error: e.message }))];
      }
      await this.repo.assignments.setMany(save);
      this.aiErrorToPause(e);
    }
    for (const it of localOnly) out.push({ id: it.id, kind: 'done' });
    await this.repo.assignments.setMany(save);
    return out;
  }

  async estimate(task: 'discover' | 'classify', scope: 'uncertain' | 'all', folderIds: string[]) {
    const s = await this.repo.settings();
    const { items } = await this.selectedItems(folderIds, true);
    const t = await this.repo.taxonomy();
    let n = items.length;
    if (task === 'discover') n = Math.min(items.length, s.ai.sampleSize);
    else if (scope === 'uncertain' && t) {
      const clf = new RulesClassifier(t);
      n = items.filter((it) => clf.classify(it, 0).band !== 'high').length;
    }
    const avgTitle = items.length ? items.slice(0, 500).reduce((a, x) => a + estimateTokens(JSON.stringify({ i: 1, t: x.title.slice(0, 140), u: x.url.slice(0, 80) })), 0) / Math.min(500, items.length) : 30;
    const taxTokens = t ? estimateTokens(JSON.stringify(t.categories.map((c) => [c.id, c.name, c.definition.slice(0, 100)]))) : 1500;
    const est = estimateRun({
      model: s.ai.gemini.model,
      items: n,
      batchSize: task === 'discover' ? 80 : 60,
      promptOverheadTokens: (task === 'discover' ? 1800 : 600) + (task === 'classify' ? taxTokens : 0),
      perItemInputTokens: Math.ceil(avgTitle),
      perItemOutputTokens: task === 'discover' ? 12 : 45,
      extraRequests: task === 'discover' ? 1 : 0,
    });
    return { items: n, ...est, budget: s.ai.budget };
  }

  // ───────────────────────── planning & applying

  async resolvedAssignments(flat: FlatTree, t: Taxonomy, s: Settings): Promise<Map<string, Assignment>> {
    const stored = await this.repo.assignments.all();
    const overrides = await this.repo.overrides.all();
    const rules: UserRule[] = await this.repo.rules();
    const clf = new RulesClassifier(t);
    const now = this.p.clock.now();
    const out = new Map<string, Assignment>();
    const prot = new Set(s.protectedFolderIds);
    for (const b of flat.bookmarks) {
      out.set(
        b.id,
        resolveAssignment(
          { id: b.id, title: b.title, url: b.url, folderPath: b.path, pathIds: b.pathIds },
          { taxonomy: t, protectedFolderIds: prot, excludedBookmarkIds: new Set(), overrides, rules, stored: stored.get(b.id), classify: (x) => clf.classify(x, now), now },
        ),
      );
    }
    return out;
  }

  async buildPlan() {
    const s = await this.repo.settings();
    const t = await this.repo.taxonomy();
    if (!t) throw new Error('Approve a taxonomy first.');
    const { root, flat } = await this.tree();
    const roots = discoverRoots(root);
    const dest = s.destinationRootId && flat.byId.has(s.destinationRootId) ? s.destinationRootId : roots.other;
    if (!dest) throw new Error('Choose a destination folder in Settings.');
    const assignments = await this.resolvedAssignments(flat, t, s);
    const plan = buildOrganizePlan({
      tree: root,
      flat,
      taxonomy: t,
      assignments,
      folderMap: await this.repo.folderMap(),
      now: this.p.clock.now(),
      id: newId('plan_'),
      settings: { destinationRootId: dest, rootFolderName: s.rootFolderName, includeBands: s.includeBands, scopeFolderIds: [], protectedFolderIds: s.protectedFolderIds, skipAlreadyOrganized: true },
    });
    await this.repo.savePlan(plan);
    return plan;
  }

  /** Batches started by runBulk, so callers/tests can await completion. */
  readonly running = new Map<string, Promise<BatchHeader>>();

  /**
   * Refresh → verified snapshot → persisted journal → run in the background.
   * Throws before any change if the snapshot or journal cannot be stored.
   */
  private async runBulk(kind: BatchHeader['kind'], label: string, steps: Parameters<Journal['begin']>[2], extra: { fingerprint?: string; taxonomyVersion?: number; undoOf?: string } = {}, after?: (done: BatchHeader) => Promise<void>): Promise<BatchHeader> {
    if (!steps.length) throw new Error('Nothing to change.');
    const snap = await this.snapshots.capture(this.p.api, `before ${kind}: ${label}`);
    const h = await this.journal.begin(kind, label, steps, { source: 'user', snapshotId: snap.id, ...extra });
    // The message reply returns immediately; the journal persists progress for recovery.
    const done = this.journal.run(h.id).then(async (d) => {
      if (after) await after(d);
      await this.armWake();
      this.running.delete(h.id);
      return d;
    });
    this.running.set(h.id, done);
    await this.armWake();
    return h;
  }

  async applyPlan(planId: string, fingerprint: string): Promise<BatchHeader> {
    const plan = await this.repo.plan();
    const t = await this.repo.taxonomy();
    if (!plan || plan.id !== planId || plan.fingerprint !== fingerprint) throw new Error('This preview is out of date. Rebuild the preview and review it again.');
    if (!t || !planIsCurrent(plan, t)) throw new Error('The taxonomy changed since this preview was built. Rebuild the preview.');
    const steps = planToSteps(plan);
    return this.runBulk('organize', `Organize ${plan.moves.length} bookmarks`, steps, { fingerprint: plan.fingerprint, taxonomyVersion: plan.taxonomyVersion }, async (done) => {
      // Record folder mapping for deterministic reuse.
      const states = await this.journal.states(done);
      await this.repo.mergeFolderMap(folderMapFromResults(plan, steps, states.map((x) => x.rid)));
      await this.repo.savePlan(null);
    });
  }

  async applyRemoval(removeIds: string[], reason: 'duplicates' | 'dead-links'): Promise<BatchHeader> {
    const { flat } = await this.tree();
    if (reason === 'dead-links') {
      // Only bookmarks with a confirmed (rechecked) not-found result may be offered for cleanup.
      const recs = await this.repo.health.getMany(removeIds);
      const bad = removeIds.filter((id) => {
        const r = recs.get(id);
        const b = flat.byId.get(id) as { url?: string } | undefined;
        return !r || r.status !== 'not-found' || !r.notFoundConfirmedAt || r.url !== b?.url;
      });
      if (bad.length) throw new Error(`${bad.length} selected bookmark(s) do not have a confirmed "Not found" result; recheck them first.`);
    }
    const steps = dedupeSteps(flat, removeIds);
    return this.runBulk(reason === 'duplicates' ? 'dedupe' : 'cleanup', `Remove ${steps.length} ${reason === 'duplicates' ? 'duplicate' : 'not-found'} bookmark(s)`, steps);
  }

  /**
   * Undo a batch. Small batches finish before replying; large ones continue in
   * the background (journaled, resumable) so no single event runs for minutes.
   */
  async undoBatch(batchId: string): Promise<BatchHeader> {
    const h = await this.journal.header(batchId);
    if (!h) throw new Error('Unknown batch');
    const snap = h.kind === 'autofile' ? undefined : await this.snapshots.capture(this.p.api, `before undo: ${h.label}`);
    const done = this.journal.undo(batchId, snap ? { snapshotId: snap.id } : {}).finally(() => this.armWake());
    const quick = await Promise.race([done, new Promise<null>((r) => setTimeout(() => r(null), 20_000))]);
    if (quick) return quick;
    const latest = (await this.journal.index()).find((x) => x.undoOf === batchId);
    if (latest) this.running.set(latest.id, done);
    return latest ?? h;
  }

  async restoreTree(root: SnapNode, parentId: string, label: string): Promise<BatchHeader> {
    const { flat, root: live } = await this.tree();
    const isPermanent = (live.children ?? []).some((c) => c.id === parentId);
    const f = flat.byId.get(parentId);
    if (!isPermanent && (!f || 'url' in f || !f.writable)) throw new Error('Choose a writable destination folder.');
    const stamp = new Date(this.p.clock.now()).toISOString().slice(0, 16).replace('T', ' ');
    const container: SnapNode = { title: `${label} ${stamp}`, children: flattenRootForRestore(root) };
    const steps = recreateSteps(container, { id: parentId }, undefined, 'r');
    const c = countSnap(container);
    return this.runBulk('restore', `${label}: ${c.bookmarks} bookmarks into a new folder`, steps);
  }

  async restorePending(parentId: string, label: string): Promise<BatchHeader> {
    const root = await getChunked<SnapNode>(this.p.store, 'restore:pending');
    if (!root) throw new Error('No validated file is waiting to be restored.');
    const h = await this.restoreTree(root, parentId, label);
    await removeChunked(this.p.store, 'restore:pending');
    return h;
  }

  // ───────────────────────── message handling

  async handle(msg: Msg): Promise<unknown> {
    await this.ensureRecovered();
    switch (msg.type) {
      case 'ping':
        return { version: this.p.appVersion };
      case 'updateSettings': {
        const cur = await this.repo.settings();
        const next = updateSettings(cur, msg.patch);
        // Consent and activation stamps are only changed through dedicated messages.
        next.ai.cloudConsentAt = cur.ai.cloudConsentAt;
        next.autoFile.enabled = cur.autoFile.enabled;
        next.autoFile.activatedAt = cur.autoFile.activatedAt;
        await this.repo.saveSettings(next);
        return next;
      }
      case 'auditStart':
        return this.startAudit(msg.mode, msg.folderIds, msg.ids);
      case 'auditRetry':
        return this.startAudit('all', [], msg.ids);
      case 'jobControl': {
        const r = (msg.job === 'audit' ? this.audit : msg.job === 'classify' ? this.classify : this.discover) as JobRunner<unknown>;
        const st = msg.action === 'pause' ? await r.pause() : msg.action === 'resume' ? await r.resume() : await r.cancel();
        if (msg.action === 'resume') void this.tick();
        return st;
      }
      case 'removeApply':
        return this.applyRemoval(msg.removeIds, msg.reason);
      case 'discoverStart':
        return this.startDiscovery(msg.provider, msg.folderIds);
      case 'taxonomyFromFolders': {
        const { flat } = await this.tree();
        const s = await this.repo.settings();
        const t = taxonomyFromFolders(await this.folderInfos(flat), newId('tax_'), this.p.clock.now(), s.granularity);
        await this.repo.saveDraftTaxonomy(t);
        return t;
      }
      case 'taxonomyParse': {
        const s = await this.repo.settings();
        const t = parseUserTaxonomy(msg.text, newId('tax_'), this.p.clock.now(), s.granularity);
        await this.repo.saveDraftTaxonomy(t);
        return t;
      }
      case 'taxonomyEdit': {
        const now = this.p.clock.now();
        if (msg.target === 'draft') {
          const d = await this.repo.draftTaxonomy();
          if (!d) throw new Error('No draft taxonomy');
          const next = applyEdit(d, msg.edit, now);
          await this.repo.saveDraftTaxonomy(next);
          return next;
        }
        const cur = await this.repo.taxonomy();
        if (!cur) throw new Error('No approved taxonomy');
        const next = applyEdit(cur, msg.edit, now);
        await this.repo.saveTaxonomy(next);
        const plan = await this.repo.plan();
        if (plan && !planIsCurrent(plan, next)) await this.repo.savePlan(null);
        return next;
      }
      case 'taxonomyAdopt': {
        const d = await this.repo.draftTaxonomy();
        if (!d) throw new Error('No draft taxonomy');
        const t = freeze(unfreeze(d, this.p.clock.now()), this.p.clock.now());
        await this.repo.saveTaxonomy(t);
        await this.repo.saveDraftTaxonomy(null);
        await this.repo.savePlan(null);
        return t;
      }
      case 'taxonomyDiscardDraft':
        await this.repo.saveDraftTaxonomy(null);
        return true;
      case 'classifyStart':
        return this.startClassification(msg.provider, msg.scope, msg.folderIds);
      case 'planBuild':
        return this.buildPlan();
      case 'planApply':
        return this.applyPlan(msg.planId, msg.fingerprint);
      case 'batchUndo':
        return this.undoBatch(msg.batchId);
      case 'snapshotNow':
        return this.snapshots.capture(this.p.api, 'manual');
      case 'snapshotDelete':
        await this.snapshots.delete(msg.id);
        return true;
      case 'snapshotRestore': {
        const root = await this.snapshots.get(msg.id);
        if (!root) throw new Error('Snapshot not found');
        return this.restoreTree(root, msg.parentId, 'Restored Bookmarks');
      }
      case 'restoreApply':
        return this.restorePending(msg.parentId, msg.label);
      case 'autofileEnable': {
        const s = await this.repo.settings();
        s.autoFile.enabled = msg.enabled;
        if (msg.enabled && !s.autoFile.activatedAt) s.autoFile.activatedAt = this.p.clock.now();
        if (msg.enabled) s.autoFile.paused = false;
        await this.repo.saveSettings(s);
        return s;
      }
      case 'autofilePause': {
        const s = await this.repo.settings();
        s.autoFile.paused = msg.paused;
        await this.repo.saveSettings(s);
        if (!msg.paused) void this.tick();
        return s;
      }
      case 'autofileUndo':
        return this.autofile.undo(msg.activityId);
      case 'autofileChange':
        return this.autofile.changeCategory(msg.bookmarkId, msg.categoryId);
      case 'autofileRelease':
        return this.autofile.releaseHeld(msg.ids, msg.action);
      case 'assign': {
        const now = this.p.clock.now();
        const t = await this.repo.taxonomy();
        if (msg.categoryId !== null && !t?.categories.some((c) => c.id === msg.categoryId)) throw new Error('Unknown category');
        await this.repo.overrides.setMany(msg.bookmarkIds.map((id) => [id, { categoryId: msg.categoryId, at: now, reason: msg.categoryId === null ? 'keep' : 'manual-assign' }]));
        const plan = await this.repo.plan();
        if (plan) await this.repo.savePlan(null);
        return msg.bookmarkIds.length;
      }
      case 'ruleAdd': {
        const rules = await this.repo.rules();
        rules.push({ id: newId('rule_'), kind: msg.kind, pattern: msg.pattern, categoryId: msg.categoryId, approved: true, createdAt: this.p.clock.now(), source: 'user' });
        await this.repo.saveRules(rules);
        return rules;
      }
      case 'ruleApprove': {
        const rules = await this.repo.rules();
        const r = rules.find((x) => x.id === msg.id);
        if (r) r.approved = msg.approved;
        await this.repo.saveRules(rules);
        return rules;
      }
      case 'ruleDelete': {
        const rules = (await this.repo.rules()).filter((x) => x.id !== msg.id);
        await this.repo.saveRules(rules);
        return rules;
      }
      case 'geminiKeySet':
        await this.p.keyStore.set(msg.key, msg.persist);
        {
          const s = await this.repo.settings();
          s.ai.gemini.persistKey = msg.persist;
          await this.repo.saveSettings(s);
        }
        return this.p.keyStore.status();
      case 'geminiKeyClear':
        await this.p.keyStore.clear();
        return this.p.keyStore.status();
      case 'geminiTest': {
        const s = await this.repo.settings();
        if (!s.ai.cloudConsentAt) throw new Error('Give consent for cloud processing first.');
        const prov = (await this.provider('gemini'))!;
        const res = await prov.generate({ task: 'classify', system: 'Reply with JSON only.', prompt: 'Return {"ok": true}.', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }, maxOutputTokens: 64 });
        return { ok: (res.data as { ok?: boolean })?.ok === true, usage: res.usage, model: prov.model };
      }
      case 'cloudConsent': {
        const s = await this.repo.settings();
        s.ai.cloudConsentAt = msg.granted ? this.p.clock.now() : null;
        if (!msg.granted) {
          if (s.ai.provider === 'gemini') s.ai.provider = 'rules';
          if (s.autoFile.provider === 'gemini') s.autoFile.provider = 'rules';
        }
        await this.repo.saveSettings(s);
        return s;
      }
      case 'aiAvailability':
        return this.aiAvailability();
      case 'estimate':
        return this.estimate(msg.task, msg.scope, msg.folderIds);
      case 'clearCaches':
        await this.repo.clearCaches();
        return true;
      case 'deleteAllData':
        await Promise.all([this.audit.cancel(), this.classify.cancel(), this.discover.cancel()]);
        await this.repo.deleteAll();
        await this.p.keyStore.clear();
        this.p.wake(null);
        return true;
      case 'permissionsChanged':
        // Items without permission are recorded as skipped (not failed) on their next attempt.
        this.invalidatePermissionCache();
        return true;
    }
  }
}

/** A restored backup's root holds the permanent folders; restore their contents as subfolders. */
function flattenRootForRestore(root: SnapNode): SnapNode[] {
  return (root.children ?? []).map((c) => (c.url === undefined ? { title: c.title || 'Folder', children: c.children ?? [] } : c));
}
