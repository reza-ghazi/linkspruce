/**
 * Repository over persisted LinkSpruce state (chrome.storage.local).
 * Keys are namespaced and versioned; secrets are never stored here.
 */
import type { UsageLedger } from './ai/budget.ts';
import type { Assignment } from './classify/classifier.ts';
import type { Correction, Override, UserRule } from './classify/precedence.ts';
import type { Clock, KeyValueStore } from './platform.ts';
import type { FolderMapEntry, OrganizePlan } from './plan.ts';
import { getChunked, putChunked, removeChunked, ShardedMap } from './store.ts';
import { migrateSettings, type Settings } from './settings.ts';
import type { Taxonomy } from './taxonomy/taxonomy.ts';
import type { HealthStatus, Confidence } from './audit/probe.ts';
import type { PageMeta } from './audit/html-meta.ts';

export interface HealthRecord {
  url: string;
  status: HealthStatus;
  confidence: Confidence;
  flags: string[];
  httpStatus?: number | undefined;
  finalUrl?: string | undefined;
  redirected?: boolean | undefined;
  checkedAt: number;
  attempts: number;
  note?: string | undefined;
  /** First and latest not-found observations (cleanup requires a recheck). */
  notFoundFirstAt?: number | undefined;
  notFoundConfirmedAt?: number | undefined;
  meta?: Pick<PageMeta, 'title' | 'description' | 'canonical' | 'lang' | 'ogTitle' | 'ogSiteName'> | undefined;
  skipReason?: string | undefined;
}

export const TAXONOMY_HISTORY = 6;

export class Repo {
  readonly store: KeyValueStore;
  readonly clock: Clock;
  readonly assignments: ShardedMap<Assignment>;
  readonly health: ShardedMap<HealthRecord>;
  readonly overrides: ShardedMap<Override>;

  constructor(store: KeyValueStore, clock: Clock) {
    this.store = store;
    this.clock = clock;
    this.assignments = new ShardedMap<Assignment>(store, 'as');
    this.health = new ShardedMap<HealthRecord>(store, 'hl');
    this.overrides = new ShardedMap<Override>(store, 'ov', 16);
  }

  async settings(): Promise<Settings> {
    return migrateSettings(await this.store.get('settings'));
  }
  async saveSettings(s: Settings): Promise<void> {
    await this.store.set({ settings: s });
  }

  async taxonomy(): Promise<Taxonomy | undefined> {
    return this.store.get<Taxonomy>('taxonomy:current');
  }
  /** Save a taxonomy version, keeping a short history for review/rollback. */
  async saveTaxonomy(t: Taxonomy): Promise<void> {
    const hist = (await this.store.get<Array<{ id: string; version: number; at: number }>>('taxonomy:history')) ?? [];
    const prev = await this.taxonomy();
    const items: Record<string, unknown> = { 'taxonomy:current': t };
    if (prev && (prev.id !== t.id || prev.version !== t.version)) {
      items[`taxonomy:v:${prev.id}:${prev.version}`] = prev;
      hist.push({ id: prev.id, version: prev.version, at: this.clock.now() });
      while (hist.length > TAXONOMY_HISTORY) {
        const old = hist.shift()!;
        await this.store.remove(`taxonomy:v:${old.id}:${old.version}`);
      }
      items['taxonomy:history'] = hist;
    }
    await this.store.set(items);
  }
  async draftTaxonomy(): Promise<Taxonomy | undefined> {
    return this.store.get<Taxonomy>('taxonomy:draft');
  }
  async saveDraftTaxonomy(t: Taxonomy | null): Promise<void> {
    if (t) await this.store.set({ 'taxonomy:draft': t });
    else await this.store.remove('taxonomy:draft');
  }

  async rules(): Promise<UserRule[]> {
    return (await this.store.get<UserRule[]>('rules')) ?? [];
  }
  async saveRules(r: UserRule[]): Promise<void> {
    await this.store.set({ rules: r.slice(0, 2000) });
  }

  async corrections(): Promise<Correction[]> {
    return (await this.store.get<Correction[]>('corrections')) ?? [];
  }
  async addCorrection(c: Correction): Promise<void> {
    const list = await this.corrections();
    list.push(c);
    await this.store.set({ corrections: list.slice(-1000) });
  }

  async folderMap(): Promise<Map<string, FolderMapEntry>> {
    const raw = (await this.store.get<Record<string, FolderMapEntry>>('folderMap')) ?? {};
    return new Map(Object.entries(raw));
  }
  async mergeFolderMap(entries: FolderMapEntry[]): Promise<void> {
    const raw = (await this.store.get<Record<string, FolderMapEntry>>('folderMap')) ?? {};
    for (const e of entries) raw[e.categoryId] = e;
    await this.store.set({ folderMap: raw });
  }

  async plan(): Promise<OrganizePlan | undefined> {
    return getChunked<OrganizePlan>(this.store, 'plan:current');
  }
  async savePlan(p: OrganizePlan | null): Promise<void> {
    if (p) await putChunked(this.store, 'plan:current', p);
    else await removeChunked(this.store, 'plan:current');
  }

  async ledger(key: string): Promise<UsageLedger | undefined> {
    return this.store.get<UsageLedger>(`ledger:${key}`);
  }
  async saveLedger(key: string, l: UsageLedger): Promise<void> {
    await this.store.set({ [`ledger:${key}`]: l });
  }

  /** Delete caches (health results, assignments) without touching settings, taxonomy or backups. */
  async clearCaches(): Promise<void> {
    await this.health.clear();
    await this.assignments.clear();
    await this.savePlan(null);
  }

  /** Delete every LinkSpruce key, including backups and journals. */
  async deleteAll(): Promise<void> {
    const keys = await this.store.keys('');
    await this.store.remove(keys);
    this.assignments.invalidate();
    this.health.invalidate();
    this.overrides.invalidate();
  }
}
