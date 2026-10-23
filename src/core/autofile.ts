/**
 * Automatic filing of newly saved bookmarks (standing authorization once
 * the user enables it).
 *
 * Flow: onCreated → persisted queue item (settling) → after the settle
 * period, re-read the bookmark → classify (rules / on-device / cloud as
 * configured, never switching providers silently) → choose an existing
 * category or create one under policy limits → re-read again → move via a
 * journaled single-item batch → activity entry with Undo / Change category.
 *
 * Safety: LinkSpruce's own operations are recognised through the persisted
 * journal registry; manual moves cancel pending work and become overrides;
 * removed bookmarks drop their job; edits re-settle; bursts and imports are
 * held for bulk review; anything ambiguous stays where the user saved it.
 */
import type { PageMeta } from './audit/html-meta.ts';
import { classifyBatch, type AiContext } from './ai/pipeline.ts';
import { ProviderError, type AiProvider, type ProviderId } from './ai/types.ts';
import { emptyLedger, type Budget, type UsageLedger } from './ai/budget.ts';
import type { SnapshotStore } from './backup.ts';
import { RulesClassifier, type Assignment, type Band } from './classify/classifier.ts';
import type { ItemInput } from './classify/features.ts';
import { resolveAssignment, type Override } from './classify/precedence.ts';
import { guessConcept } from './discovery/discovery.ts';
import type { Journal, ParentRef, Step } from './journal.ts';
import type { BmNode, BookmarksApi, Clock } from './platform.ts';
import type { Repo } from './repo.ts';
import type { Settings } from './settings.ts';
import { newId } from './store.ts';
import { conceptPath } from './taxonomy/lexicon.ts';
import { activeCategories, addAutoCategory, byId, depthOf, displayName, emptyTaxonomy, findEquivalent, pathLabel, pathOf, type Category, type Taxonomy } from './taxonomy/taxonomy.ts';
import { foldText, isWeakTitle } from './text.ts';
import { flattenTree, discoverRoots } from './tree.ts';
import { siteOf } from './url.ts';

export type QueueStatus = 'settling' | 'retry' | 'held' | 'review' | 'done' | 'cancelled' | 'error';

export interface QueueItem {
  id: string;
  title: string;
  url: string;
  parentId: string;
  firstSeen: number;
  dueAt: number;
  version: number;
  status: QueueStatus;
  attempts: number;
  reason?: string | undefined;
  burstId?: string | undefined;
  updatedAt: number;
}

export type ActivityKind = 'filed' | 'review' | 'skipped' | 'error' | 'undone' | 'held' | 'moved-by-user';

export interface ActivityEntry {
  id: string;
  at: number;
  kind: ActivityKind;
  bookmarkId: string;
  title: string;
  fromPath?: string[] | undefined;
  toPath?: string[] | undefined;
  categoryId?: string | undefined;
  createdCategories?: string[] | undefined;
  batchId?: string | undefined;
  rationale?: string | undefined;
  band?: Band | null | undefined;
  provider?: string | undefined;
  message?: string | undefined;
  undone?: boolean | undefined;
}

export interface AutoFileDeps {
  repo: Repo;
  api: BookmarksApi;
  journal: Journal;
  clock: Clock;
  snapshots: SnapshotStore;
  /** Resolve the configured AI provider; null = rules. Throws/returns null if unavailable. */
  provider: (id: ProviderId) => Promise<AiProvider | null>;
  /** Optional bounded metadata fetch for weak titles (only with host permission). */
  fetchMeta?: ((url: string) => Promise<PageMeta | undefined>) | undefined;
  /** Arrange a wake-up at (or soon after) the given time. */
  schedule: (atMs: number) => void;
  onActivity?: ((e: ActivityEntry) => void) | undefined;
}

const QUEUE_KEY = 'autofile:queue';
const ACTIVITY_KEY = 'autofile:activity';
const BURST_KEY = 'autofile:burst';
const DAILY_KEY = 'autofile:daily';
const SNAP_KEY = 'autofile:snapshots';
const MAX_ACTIVITY = 500;
const MAX_QUEUE = 2000;
/** dateAdded older than this at first sight → likely a sync/import arrival. */
const SYNC_AGE_MS = 2 * 60_000;
const MAX_ATTEMPTS = 3;
const PERIODIC_SNAPSHOT_EVERY = 50;
const PERIODIC_SNAPSHOT_MAX_AGE = 7 * 24 * 3600_000;

interface BurstState {
  recent: number[];
  activeId?: string | undefined;
  until?: number | undefined;
  importing?: boolean | undefined;
  importId?: string | undefined;
}

interface DailyState {
  day: string;
  newCategories: number;
  cloudRequests: number;
}

const BAND_RANK: Record<Band, number> = { low: 0, medium: 1, high: 2 };

export class AutoFiler {
  private readonly d: AutoFileDeps;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(deps: AutoFileDeps) {
    this.d = deps;
  }

  /** Serialize all queue mutations in this context. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  async queue(): Promise<Record<string, QueueItem>> {
    return (await this.d.repo.store.get<Record<string, QueueItem>>(QUEUE_KEY)) ?? {};
  }
  private async saveQueue(q: Record<string, QueueItem>): Promise<void> {
    // Prune finished items beyond the cap, oldest first.
    const entries = Object.values(q);
    if (entries.length > MAX_QUEUE) {
      const finished = entries.filter((x) => x.status === 'done' || x.status === 'cancelled').sort((a, b) => a.updatedAt - b.updatedAt);
      for (const f of finished.slice(0, entries.length - MAX_QUEUE)) delete q[f.id];
    }
    await this.d.repo.store.set({ [QUEUE_KEY]: q });
  }

  async activity(): Promise<ActivityEntry[]> {
    return (await this.d.repo.store.get<ActivityEntry[]>(ACTIVITY_KEY)) ?? [];
  }
  private async log(e: Omit<ActivityEntry, 'id' | 'at'>): Promise<ActivityEntry> {
    const entry: ActivityEntry = { id: newId('act_'), at: this.d.clock.now(), ...e };
    const list = await this.activity();
    list.unshift(entry);
    await this.d.repo.store.set({ [ACTIVITY_KEY]: list.slice(0, MAX_ACTIVITY) });
    this.d.onActivity?.(entry);
    return entry;
  }
  private async updateActivity(id: string, patch: Partial<ActivityEntry>): Promise<void> {
    const list = await this.activity();
    const e = list.find((x) => x.id === id);
    if (e) Object.assign(e, patch);
    await this.d.repo.store.set({ [ACTIVITY_KEY]: list });
  }

  private async daily(): Promise<DailyState> {
    const day = new Date(this.d.clock.now()).toISOString().slice(0, 10);
    const s = await this.d.repo.store.get<DailyState>(DAILY_KEY);
    return s && s.day === day ? s : { day, newCategories: 0, cloudRequests: 0 };
  }

  // ───────────────────────── events

  onCreated(id: string, node: BmNode): Promise<void> {
    return this.serial(async () => {
      if (node.url === undefined) return; // folders are not classification targets
      const s = await this.d.repo.settings();
      if (!s.autoFile.enabled || s.autoFile.paused) return;
      if (await this.d.journal.isOwnEvent({ kind: 'created', id, parentId: node.parentId, title: node.title, url: node.url })) return;
      const now = this.d.clock.now();
      const q = await this.queue();
      if (q[id]) return; // duplicate event
      const burst = (await this.d.repo.store.get<BurstState>(BURST_KEY)) ?? { recent: [] };
      const win = s.autoFile.burstWindowSeconds * 1000;
      burst.recent = [...burst.recent.filter((t) => now - t <= win), now];
      let heldBy: string | undefined;
      if (burst.importing) heldBy = burst.importId;
      else if (burst.activeId && (burst.until ?? 0) >= now) heldBy = burst.activeId;
      else if (burst.recent.length >= s.autoFile.burstThreshold) {
        burst.activeId = newId('burst_');
        heldBy = burst.activeId;
        // Hold everything still settling from this burst too.
        for (const it of Object.values(q)) if (it.status === 'settling' && now - it.firstSeen <= win) Object.assign(it, { status: 'held', burstId: heldBy, updatedAt: now });
      }
      if (heldBy && !burst.importing) burst.until = now + win;
      q[id] = {
        id,
        title: node.title,
        url: node.url,
        parentId: node.parentId ?? '',
        firstSeen: now,
        dueAt: now + s.autoFile.settleSeconds * 1000,
        version: 1,
        status: heldBy ? 'held' : 'settling',
        attempts: 0,
        burstId: heldBy,
        updatedAt: now,
      };
      await this.d.repo.store.set({ [BURST_KEY]: burst });
      await this.saveQueue(q);
      if (!heldBy) this.d.schedule(q[id]!.dueAt);
    });
  }

  onChanged(id: string, info: { title: string; url?: string | undefined }): Promise<void> {
    return this.serial(async () => {
      if (await this.d.journal.isOwnEvent({ kind: 'changed', id, title: info.title, url: info.url })) return;
      const q = await this.queue();
      const it = q[id];
      if (!it || (it.status !== 'settling' && it.status !== 'retry')) return;
      const s = await this.d.repo.settings();
      const now = this.d.clock.now();
      // Title/URL edits invalidate any inference; settle again.
      Object.assign(it, { title: info.title, url: info.url ?? it.url, version: it.version + 1, dueAt: now + s.autoFile.settleSeconds * 1000, updatedAt: now, status: 'settling' });
      await this.saveQueue(q);
      this.d.schedule(it.dueAt);
    });
  }

  onMoved(id: string, info: { parentId: string; oldParentId: string }): Promise<void> {
    return this.serial(async () => {
      if (await this.d.journal.isOwnEvent({ kind: 'moved', id, parentId: info.parentId })) return;
      const q = await this.queue();
      const it = q[id];
      const now = this.d.clock.now();
      if (it && (it.status === 'settling' || it.status === 'retry' || it.status === 'held' || it.status === 'review')) {
        // A manual move during processing is an explicit choice: cancel and respect it.
        Object.assign(it, { status: 'cancelled', reason: 'moved-by-user', parentId: info.parentId, updatedAt: now });
        await this.saveQueue(q);
        await this.setOverride(id, { categoryId: null, at: now, reason: 'manual-move' });
        await this.log({ kind: 'moved-by-user', bookmarkId: id, title: it.title, message: 'You moved this bookmark before it was filed; LinkSpruce will leave it there.' });
        return;
      }
      if (it && it.status === 'done') {
        // The user corrected a filed bookmark: remember it and never re-file it.
        await this.setOverride(id, { categoryId: null, at: now, reason: 'manual-move' });
        const fm = await this.d.repo.folderMap();
        const toCat = [...fm.values()].find((m) => m.folderId === info.parentId)?.categoryId ?? null;
        const fromCat = [...fm.values()].find((m) => m.folderId === info.oldParentId)?.categoryId ?? null;
        await this.d.repo.addCorrection({ bookmarkId: id, site: siteOfSafe(it.url), fromCategoryId: fromCat, toCategoryId: toCat, at: now });
        if (toCat) await this.setOverride(id, { categoryId: toCat, at: now, reason: 'manual-move' });
      }
    });
  }

  onRemoved(id: string): Promise<void> {
    return this.serial(async () => {
      const q = await this.queue();
      if (!q[id]) return;
      delete q[id];
      await this.saveQueue(q);
    });
  }

  onImportBegan(): Promise<void> {
    return this.serial(async () => {
      const burst = (await this.d.repo.store.get<BurstState>(BURST_KEY)) ?? { recent: [] };
      burst.importing = true;
      burst.importId = newId('import_');
      await this.d.repo.store.set({ [BURST_KEY]: burst });
    });
  }

  onImportEnded(): Promise<void> {
    return this.serial(async () => {
      const burst = (await this.d.repo.store.get<BurstState>(BURST_KEY)) ?? { recent: [] };
      const held = burst.importId;
      burst.importing = false;
      delete burst.importId;
      await this.d.repo.store.set({ [BURST_KEY]: burst });
      if (held) {
        const q = await this.queue();
        const n = Object.values(q).filter((x) => x.burstId === held).length;
        if (n) await this.log({ kind: 'held', bookmarkId: '', title: '', message: `${n} imported bookmark(s) are waiting for bulk review instead of being filed one by one.` });
      }
    });
  }

  // ───────────────────────── processing

  /** Process due queue items. Safe to call repeatedly (alarm, timer, message). */
  tick(maxItems = 20): Promise<{ processed: number; nextDue?: number | undefined }> {
    return this.serial(async () => {
      const s = await this.d.repo.settings();
      const q = await this.queue();
      const now = this.d.clock.now();
      // Close a quiet burst.
      const burst = (await this.d.repo.store.get<BurstState>(BURST_KEY)) ?? { recent: [] };
      if (burst.activeId && (burst.until ?? 0) < now && !burst.importing) {
        const n = Object.values(q).filter((x) => x.burstId === burst.activeId && x.status === 'held').length;
        if (n) await this.log({ kind: 'held', bookmarkId: '', title: '', message: `${n} bookmarks were created in quick succession; they are waiting for bulk review.` });
        delete burst.activeId;
        delete burst.until;
        await this.d.repo.store.set({ [BURST_KEY]: burst });
      }
      if (!s.autoFile.enabled || s.autoFile.paused) return { processed: 0 };
      const due = Object.values(q)
        .filter((x) => (x.status === 'settling' || x.status === 'retry') && x.dueAt <= now)
        .sort((a, b) => a.dueAt - b.dueAt)
        .slice(0, maxItems);
      let processed = 0;
      for (const it of due) {
        await this.processItem(it, s);
        processed++;
      }
      const q2 = await this.queue();
      const pending = Object.values(q2).filter((x) => x.status === 'settling' || x.status === 'retry');
      const nextDue = pending.length ? Math.min(...pending.map((x) => x.dueAt)) : undefined;
      if (nextDue !== undefined) this.d.schedule(nextDue);
      return { processed, nextDue };
    });
  }

  private async setItem(id: string, patch: Partial<QueueItem>): Promise<void> {
    const q = await this.queue();
    if (!q[id]) return;
    Object.assign(q[id]!, patch, { updatedAt: this.d.clock.now() });
    await this.saveQueue(q);
  }

  private async setOverride(id: string, o: Override): Promise<void> {
    await this.d.repo.overrides.set(id, o);
  }

  private async getNode(id: string): Promise<BmNode | undefined> {
    try {
      return (await this.d.api.get(id))[0];
    } catch {
      return undefined;
    }
  }

  private async processItem(it: QueueItem, s: Settings): Promise<void> {
    const now = this.d.clock.now();
    const node = await this.getNode(it.id);
    if (!node || node.url === undefined) {
      await this.onRemovedInner(it.id);
      return;
    }
    if (node.parentId !== it.parentId) {
      await this.setItem(it.id, { status: 'cancelled', reason: 'moved-by-user' });
      await this.setOverride(it.id, { categoryId: null, at: now, reason: 'manual-move' });
      return;
    }
    if (node.title !== it.title || node.url !== it.url) {
      await this.setItem(it.id, { title: node.title, url: node.url, version: it.version + 1, status: 'settling', dueAt: now + s.autoFile.settleSeconds * 1000 });
      return;
    }
    const [tree] = await this.d.api.getTree();
    const flat = flattenTree(tree!);
    const roots = discoverRoots(tree!);
    const fb = flat.byId.get(it.id);
    if (!fb || !('url' in fb)) return;
    if (!fb.writable) {
      await this.setItem(it.id, { status: 'done', reason: 'managed' });
      return;
    }
    const destRoot = s.destinationRootId && flat.byId.has(s.destinationRootId) ? s.destinationRootId : (roots.other ?? roots.bar);
    if (!destRoot) {
      await this.setItem(it.id, { status: 'error', reason: 'no-destination' });
      return;
    }
    const genRoot = (await this.d.api.getChildren(destRoot)).find((c) => c.url === undefined && foldText(c.title) === foldText(s.rootFolderName));
    if (genRoot && fb.pathIds.includes(genRoot.id)) {
      // Saved straight into a LinkSpruce folder (by the user, or filed on another synced device).
      await this.setItem(it.id, { status: 'done', reason: 'already-in-linkspruce' });
      return;
    }
    if (s.protectedFolderIds.some((p) => fb.pathIds.includes(p) || fb.parentId === p)) {
      await this.setItem(it.id, { status: 'done', reason: 'protected-folder' });
      return;
    }
    if (node.dateAdded && it.firstSeen - node.dateAdded > SYNC_AGE_MS && s.autoFile.syncedArrivals === 'review') {
      await this.setItem(it.id, { status: 'review', reason: 'synced-arrival' });
      await this.log({ kind: 'review', bookmarkId: it.id, title: it.title, message: 'Looks like it arrived from sync or another tool (older creation date), so it was left in place.' });
      return;
    }

    // Taxonomy (bootstrap an empty one if needed; it grows incrementally).
    let taxonomy = (await this.d.repo.taxonomy()) ?? emptyTaxonomy(newId('tax_'), now, 'discover', s.granularity);
    const item: ItemInput = { id: it.id, title: node.title, url: node.url, folderPath: fb.path };
    if (s.autoFile.fetchMetadataForWeakTitles && isWeakTitle(node.title) && this.d.fetchMeta) {
      const meta = await this.d.fetchMeta(node.url).catch(() => undefined);
      if (meta) item.meta = { title: meta.title, description: meta.description, ogTitle: meta.ogTitle, siteName: meta.ogSiteName };
    }

    // Classify according to precedence; AI only through the configured provider.
    let providerNote: string | undefined;
    const override = await this.d.repo.overrides.get(it.id);
    const rules = await this.d.repo.rules();
    let aiAssignment: Assignment | undefined;
    if (s.autoFile.provider !== 'rules' && !override && activeCategories(taxonomy).length > 0 && !s.aiExcludedFolderIds.some((f) => fb.pathIds.includes(f))) {
      try {
        aiAssignment = await this.classifyWithAi(item, taxonomy, s);
      } catch (e) {
        const pe = e instanceof ProviderError ? e : undefined;
        if (pe?.retryable && it.attempts + 1 < MAX_ATTEMPTS) {
          await this.setItem(it.id, { status: 'retry', attempts: it.attempts + 1, dueAt: now + Math.min(15 * 60_000, (pe.retryAfterMs ?? 30_000) * (it.attempts + 1)), reason: pe.kind });
          return;
        }
        // 'auto' quietly uses offline rules when the on-device model isn't ready; an explicit choice is reported.
        if (s.autoFile.provider !== 'auto') providerNote = `AI provider unavailable (${(e as Error).message.slice(0, 100)}); offline rules were used.`;
      }
    }
    const assignment: Assignment = resolveAssignment(
      { ...item, pathIds: fb.pathIds },
      {
        taxonomy,
        protectedFolderIds: new Set(s.protectedFolderIds),
        excludedBookmarkIds: new Set(),
        overrides: new Map(override ? [[it.id, override]] : []),
        rules,
        stored: aiAssignment,
        classify: (x) => new RulesClassifier(taxonomy).classify(x, now),
        now,
      },
    );
    if (override && override.categoryId === null) {
      await this.setItem(it.id, { status: 'done', reason: 'user-override' });
      return;
    }

    // Decide target category, possibly creating one.
    const created: string[] = [];
    let target: Category | undefined;
    const minRank = BAND_RANK[s.autoFile.minBand];
    const acceptable = assignment.categoryId && assignment.band && BAND_RANK[assignment.band] >= minRank && (!assignment.needsReview || assignment.provider === 'user' || assignment.provider === 'user-rule');
    if (acceptable) target = byId(taxonomy).get(assignment.categoryId!);
    if (!target && s.autoFile.allowNewCategories && !assignment.needsReview?.startsWith('competing')) {
      const proposal = await this.proposeCategory(item, taxonomy, assignment, s);
      if (proposal) {
        taxonomy = proposal.taxonomy;
        target = proposal.category;
        created.push(...proposal.created);
      }
    }
    if (!target) {
      await this.setItem(it.id, { status: 'review', reason: assignment.needsReview ?? 'no-category' });
      await this.d.repo.assignments.set(it.id, assignment);
      await this.log({ kind: 'review', bookmarkId: it.id, title: it.title, rationale: assignment.rationale, band: assignment.band, provider: assignment.provider, message: providerNote ?? 'Not confident enough to file automatically; left where you saved it.' });
      return;
    }

    // Persist taxonomy growth before touching bookmarks (invalidates stale bulk plans via version).
    if (created.length) {
      await this.d.repo.saveTaxonomy(taxonomy);
      const plan = await this.d.repo.plan();
      if (plan && plan.taxonomyVersion !== taxonomy.version) await this.d.repo.savePlan(null);
    } else if (!(await this.d.repo.taxonomy())) {
      await this.d.repo.saveTaxonomy(taxonomy);
    }

    // Resolve/create folders and move — re-reading state just before the batch.
    const fresh = await this.getNode(it.id);
    if (!fresh || fresh.parentId !== it.parentId || fresh.title !== it.title || fresh.url !== it.url) {
      await this.setItem(it.id, { status: 'settling', dueAt: now + s.autoFile.settleSeconds * 1000, version: it.version + 1 });
      return;
    }
    const { steps, folderRefs } = await this.folderSteps(taxonomy, target.id, destRoot, s.rootFolderName);
    steps.push({ op: 'move', id: it.id, to: folderRefs.get(target.id)!, expect: { parentId: it.parentId, url: it.url } });
    let header;
    try {
      header = await this.d.journal.begin('autofile', `Saved to ${pathLabel(taxonomy, target.id)}`, steps, { source: 'autofile', taxonomyVersion: taxonomy.version, meta: { bookmarkId: it.id, categoryId: target.id } });
    } catch (e) {
      // Recovery journal not durable: leave the bookmark untouched.
      await this.setItem(it.id, { status: 'error', reason: 'journal-unavailable' });
      await this.log({ kind: 'error', bookmarkId: it.id, title: it.title, message: (e as Error).message });
      return;
    }
    const done = await this.d.journal.run(header.id);
    const states = await this.d.journal.states(done);
    const moveState = states[states.length - 1]!;
    // Record generated folder mapping (created or reused).
    const entries = [];
    for (const [catId, ref] of folderRefs) {
      if ('id' in ref) entries.push({ categoryId: catId, folderId: ref.id, name: byId(taxonomy).get(catId)?.name ?? '' });
      else {
        const i = steps.findIndex((x) => x.op === 'create' && x.ref === ref.ref);
        const rid = i >= 0 ? states[i]?.rid : undefined;
        if (rid) entries.push({ categoryId: catId, folderId: rid, name: byId(taxonomy).get(catId)?.name ?? '' });
      }
    }
    await this.d.repo.mergeFolderMap(entries);
    if (moveState.s !== 'done') {
      const conflict = moveState.s === 'conflict';
      await this.setItem(it.id, { status: conflict ? 'cancelled' : 'error', reason: moveState.err ?? moveState.s });
      await this.log({ kind: conflict ? 'skipped' : 'error', bookmarkId: it.id, title: it.title, batchId: done.id, message: moveState.err ?? 'Move failed' });
      return;
    }
    await this.d.repo.assignments.set(it.id, { ...assignment, categoryId: target.id });
    await this.setItem(it.id, { status: 'done', reason: undefined });
    await this.log({
      kind: 'filed',
      bookmarkId: it.id,
      title: it.title,
      fromPath: fb.path,
      toPath: [s.rootFolderName, ...pathOf(taxonomy, target.id).map((c) => displayName(taxonomy, c))],
      categoryId: target.id,
      createdCategories: created.map((id) => pathLabel(taxonomy, id)),
      batchId: done.id,
      rationale: assignment.rationale,
      band: assignment.band,
      provider: assignment.provider,
      message: providerNote,
    });
    await this.maybePeriodicSnapshot();
  }

  private async onRemovedInner(id: string): Promise<void> {
    const q = await this.queue();
    delete q[id];
    await this.saveQueue(q);
  }

  private async classifyWithAi(item: ItemInput, taxonomy: Taxonomy, s: Settings): Promise<Assignment | undefined> {
    const provider = await this.d.provider(s.autoFile.provider);
    if (!provider) throw new ProviderError('unavailable', 'Provider not available', { retryable: false });
    const av = await provider.availability();
    if (av.state !== 'available') throw new ProviderError('unavailable', `Provider state: ${av.state}`, { retryable: false });
    const daily = await this.daily();
    if (provider.kind === 'cloud') {
      if (!s.ai.cloudConsentAt) throw new ProviderError('auth', 'Cloud processing has not been consented to', { retryable: false });
      if (daily.cloudRequests >= s.autoFile.maxCloudRequestsPerDay) throw new ProviderError('quota', 'Daily cloud request limit reached', { retryable: false });
    }
    const ledgerKey = `autofile:${daily.day}`;
    const ledger: UsageLedger = (await this.d.repo.ledger(ledgerKey)) ?? emptyLedger(this.d.clock.now());
    const budget: Budget = { ...s.ai.budget, maxRequests: s.autoFile.maxCloudRequestsPerDay };
    const ctx: AiContext = {
      provider,
      budget,
      ledger,
      policy: s.ai.dataPolicy,
      labelLanguage: s.labelLanguage,
      onUsage: async (l) => {
        await this.d.repo.saveLedger(ledgerKey, l);
        if (provider.kind === 'cloud') await this.d.repo.store.set({ [DAILY_KEY]: { ...(await this.daily()), cloudRequests: l.requests } });
      },
    };
    const res = await classifyBatch([item], taxonomy, ctx, { now: this.d.clock.now(), allowNewCategories: s.autoFile.allowNewCategories, shortlist: provider.kind === 'on-device' });
    return res.assignments[0];
  }

  /**
   * Find or create a category for a bookmark with no suitable existing one.
   * Uses the AI's suggested category, or the offline lexicon concept when the
   * evidence is strong. Searches existing definitions and aliases first.
   */
  private async proposeCategory(item: ItemInput, t0: Taxonomy, a: Assignment, s: Settings): Promise<{ taxonomy: Taxonomy; category: Category; created: string[] } | null> {
    const now = this.d.clock.now();
    const daily = await this.daily();
    const created: string[] = [];
    let t = t0;
    const budgetLeft = () => daily.newCategories + created.length < s.autoFile.maxNewCategoriesPerDay;
    const add = (name: string, nameFa: string | undefined, parentId: string | null, def: string, conceptKeys: string[], rationale: string): Category | null => {
      if (parentId === null && !s.autoFile.allowNewTopLevel) return null;
      if (parentId !== null && depthOf(t, parentId) + 1 > t.granularity.maxDepth) return null;
      const eq = findEquivalent(t, name, parentId) ?? (parentId === null ? findEquivalent(t, name) : undefined);
      if (eq) return eq;
      if (!budgetLeft()) return null;
      try {
        const r = addAutoCategory(t, { name, nameFa, parentId, definition: def, conceptKeys, rationale }, now);
        t = r.taxonomy;
        if (!r.reused) created.push(r.category.id);
        return r.category;
      } catch {
        return null;
      }
    };
    if (a.suggestedCategory) {
      const c = add(a.suggestedCategory.name, undefined, a.suggestedCategory.parentId, a.suggestedCategory.definition ?? '', [], `Created for “${item.title.slice(0, 60)}” (${a.provider}).`);
      if (c) return this.finishProposal(t, c, created, daily);
    }
    const g = guessConcept(item, false);
    if (!g.concept || g.score < 1.6 || g.folderOnly) return null;
    const chain = conceptPath(g.concept);
    let parentId: string | null = null;
    let leaf: Category | null = null;
    for (const concept of chain) {
      const pid: string | null = parentId;
      const existing: Category | undefined =
        t.categories.find((c) => c.status === 'active' && c.conceptKeys.includes(concept.key) && c.parentId === pid) ??
        (pid === null ? t.categories.find((c) => c.status === 'active' && c.conceptKeys.includes(concept.key)) : undefined);
      const c: Category | null = existing ?? add(concept.label, concept.labelFa, pid, concept.definition, [concept.key], `Created automatically: offline evidence for ${concept.label}.`);
      if (!c) return null;
      parentId = c.id;
      leaf = c;
    }
    return leaf ? this.finishProposal(t, leaf, created, daily) : null;
  }

  private async finishProposal(t: Taxonomy, c: Category, created: string[], daily: DailyState) {
    if (created.length) await this.d.repo.store.set({ [DAILY_KEY]: { ...daily, newCategories: daily.newCategories + created.length } });
    return { taxonomy: t, category: c, created };
  }

  /** Steps to ensure the generated folder path for a category exists (reusing mapped/equivalent folders). */
  private async folderSteps(t: Taxonomy, categoryId: string, destRoot: string, rootName: string): Promise<{ steps: Step[]; folderRefs: Map<string, ParentRef> }> {
    const steps: Step[] = [];
    const refs = new Map<string, ParentRef>();
    const fm = await this.d.repo.folderMap();
    const kids = await this.d.api.getChildren(destRoot);
    const root = kids.find((k) => k.url === undefined && foldText(k.title) === foldText(rootName));
    let parentRef: ParentRef;
    if (root) parentRef = { id: root.id };
    else {
      steps.push({ op: 'create', ref: 'root', parent: { id: destRoot }, title: rootName, generated: true });
      parentRef = { ref: 'root' };
    }
    for (const c of pathOf(t, categoryId)) {
      let found: string | undefined;
      const name = displayName(t, c);
      if ('id' in parentRef) {
        const mapped = fm.get(c.id);
        const children = await this.d.api.getChildren(parentRef.id).catch(() => [] as BmNode[]);
        if (mapped && children.some((k) => k.id === mapped.folderId && k.url === undefined)) found = mapped.folderId;
        else found = children.find((k) => k.url === undefined && (foldText(k.title) === foldText(name) || foldText(k.title) === foldText(c.name)))?.id;
      }
      if (found) parentRef = { id: found };
      else {
        const ref = `c:${c.id}`;
        steps.push({ op: 'create', ref, parent: parentRef, title: name, generated: true });
        parentRef = { ref };
      }
      refs.set(c.id, parentRef);
    }
    return { steps, folderRefs: refs };
  }

  private async maybePeriodicSnapshot(): Promise<void> {
    const st = (await this.d.repo.store.get<{ count: number; lastAt: number }>(SNAP_KEY)) ?? { count: 0, lastAt: 0 };
    st.count++;
    const now = this.d.clock.now();
    if (st.count >= PERIODIC_SNAPSHOT_EVERY || now - st.lastAt > PERIODIC_SNAPSHOT_MAX_AGE) {
      try {
        await this.d.snapshots.capture(this.d.api, 'periodic (auto-filing)');
        st.count = 0;
        st.lastAt = now;
      } catch {
        /* the per-item journal still protects each move; retry next time */
      }
    }
    await this.d.repo.store.set({ [SNAP_KEY]: st });
  }

  // ───────────────────────── user actions

  /** Undo an automatic filing: restore position, remove empty generated folders, never re-file. */
  undo(activityId: string): Promise<{ ok: boolean; message: string }> {
    return this.serial(async () => {
      const e = (await this.activity()).find((x) => x.id === activityId);
      if (!e || e.kind !== 'filed' || !e.batchId) return { ok: false, message: 'Nothing to undo for this entry.' };
      if (e.undone) return { ok: false, message: 'Already undone.' };
      const h = await this.d.journal.undo(e.batchId);
      const report = await this.d.journal.report(h.id);
      const moveBack = report.find((r) => r.op === 'move');
      const ok = moveBack?.status === 'done';
      await this.setOverride(e.bookmarkId, { categoryId: null, at: this.d.clock.now(), reason: 'undo' });
      await this.updateActivity(activityId, { undone: true });
      await this.log({ kind: 'undone', bookmarkId: e.bookmarkId, title: e.title, batchId: h.id, message: ok ? 'Moved back to where you saved it.' : `Could not fully undo: ${moveBack?.error ?? 'bookmark changed since'}.` });
      return { ok, message: ok ? 'Undone.' : 'Partially undone; see Recent automatic actions.' };
    });
  }

  /** Move a bookmark to a chosen category (user decision; recorded as override + correction). */
  changeCategory(bookmarkId: string, categoryId: string): Promise<{ ok: boolean; message: string }> {
    return this.serial(async () => {
      const s = await this.d.repo.settings();
      const t = await this.d.repo.taxonomy();
      if (!t || !byId(t).get(categoryId)) return { ok: false, message: 'Unknown category.' };
      const node = await this.getNode(bookmarkId);
      if (!node || node.url === undefined) return { ok: false, message: 'Bookmark no longer exists.' };
      const [tree] = await this.d.api.getTree();
      const roots = discoverRoots(tree!);
      const destRoot = s.destinationRootId ?? roots.other ?? roots.bar!;
      const { steps, folderRefs } = await this.folderSteps(t, categoryId, destRoot, s.rootFolderName);
      steps.push({ op: 'move', id: bookmarkId, to: folderRefs.get(categoryId)!, expect: { parentId: node.parentId!, url: node.url } });
      const h = await this.d.journal.begin('autofile', `Changed to ${pathLabel(t, categoryId)}`, steps, { source: 'user', meta: { bookmarkId, categoryId } });
      const done = await this.d.journal.run(h.id);
      const fm = await this.d.repo.folderMap();
      const fromCat = [...fm.values()].find((m) => m.folderId === node.parentId)?.categoryId ?? null;
      const now = this.d.clock.now();
      await this.setOverride(bookmarkId, { categoryId, at: now, reason: 'manual-assign' });
      await this.d.repo.addCorrection({ bookmarkId, site: siteOfSafe(node.url), fromCategoryId: fromCat, toCategoryId: categoryId, at: now });
      const states = await this.d.journal.states(done);
      const entries = [];
      for (const [catId, ref] of folderRefs) {
        if ('id' in ref) entries.push({ categoryId: catId, folderId: ref.id, name: '' });
        else {
          const i = steps.findIndex((x) => x.op === 'create' && x.ref === ref.ref);
          if (i >= 0 && states[i]?.rid) entries.push({ categoryId: catId, folderId: states[i]!.rid!, name: '' });
        }
      }
      await this.d.repo.mergeFolderMap(entries);
      const ok = states[states.length - 1]?.s === 'done';
      await this.log({ kind: ok ? 'filed' : 'error', bookmarkId, title: node.title, toPath: [s.rootFolderName, ...pathOf(t, categoryId).map((c) => displayName(t, c))], categoryId, batchId: done.id, provider: 'user', rationale: 'Category chosen by you.' });
      return { ok, message: ok ? `Moved to ${pathLabel(t, categoryId)}.` : 'Could not move the bookmark.' };
    });
  }

  /** Release held (burst/import) items for normal processing, or dismiss them. */
  releaseHeld(ids: string[], action: 'file' | 'dismiss'): Promise<number> {
    return this.serial(async () => {
      const q = await this.queue();
      const now = this.d.clock.now();
      let n = 0;
      for (const id of ids) {
        const it = q[id];
        if (!it || (it.status !== 'held' && it.status !== 'review')) continue;
        if (action === 'file') Object.assign(it, { status: 'settling', dueAt: now, burstId: undefined, attempts: 0, reason: undefined, updatedAt: now });
        else Object.assign(it, { status: 'cancelled', reason: 'dismissed', updatedAt: now });
        n++;
      }
      await this.saveQueue(q);
      if (action === 'file' && n) this.d.schedule(now);
      return n;
    });
  }
}

function siteOfSafe(url: string): string {
  try {
    return siteOf(new URL(url).hostname);
  } catch {
    return '';
  }
}
