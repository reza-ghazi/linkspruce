/**
 * Storage helpers over a KeyValueStore (chrome.storage.local in the
 * extension). Large per-bookmark maps are sharded so a single update does
 * not rewrite megabytes of JSON.
 */
import type { KeyValueStore } from './platform.ts';
import { hashString } from './text.ts';

export class ShardedMap<T> {
  private cache = new Map<number, Record<string, T>>();
  private readonly prefix: string;
  private readonly shards: number;
  private readonly store: KeyValueStore;

  constructor(store: KeyValueStore, prefix: string, shards = 64) {
    this.store = store;
    this.prefix = prefix;
    this.shards = shards;
  }

  private shardOf(id: string): number {
    return parseInt(hashString(id), 36) % this.shards;
  }
  private key(shard: number): string {
    return `${this.prefix}:${shard}`;
  }

  /**
   * Load shards, returning the records used by the caller. Callers work on
   * the returned objects, so a concurrent invalidate() between awaits cannot
   * leave them holding an evicted cache entry.
   */
  private async preload(shards: number[]): Promise<Map<number, Record<string, T>>> {
    const out = new Map<number, Record<string, T>>();
    const missing: number[] = [];
    for (const s of new Set(shards)) {
      const c = this.cache.get(s);
      if (c) out.set(s, c);
      else missing.push(s);
    }
    if (missing.length) {
      const got = await this.store.getMany(missing.map((s) => this.key(s)));
      for (const s of missing) {
        const rec = this.cache.get(s) ?? (got[this.key(s)] as Record<string, T> | undefined) ?? {};
        this.cache.set(s, rec);
        out.set(s, rec);
      }
    }
    return out;
  }

  async get(id: string): Promise<T | undefined> {
    const s = this.shardOf(id);
    return (await this.preload([s])).get(s)![id];
  }

  async getMany(ids: Iterable<string>): Promise<Map<string, T>> {
    const list = [...ids];
    const recs = await this.preload(list.map((id) => this.shardOf(id)));
    const out = new Map<string, T>();
    for (const id of list) {
      const rec = recs.get(this.shardOf(id))!;
      if (id in rec) out.set(id, rec[id]!);
    }
    return out;
  }

  /** Apply puts (value) and deletes (undefined) atomically per shard. */
  async setMany(entries: Iterable<[string, T | undefined]>): Promise<void> {
    const list = [...entries];
    if (!list.length) return;
    const recs = await this.preload(list.map(([id]) => this.shardOf(id)));
    const touched = new Set<number>();
    for (const [id, value] of list) {
      const s = this.shardOf(id);
      const rec = recs.get(s)!;
      if (value === undefined) delete rec[id];
      else rec[id] = value;
      touched.add(s);
    }
    const items: Record<string, unknown> = {};
    for (const s of touched) {
      items[this.key(s)] = recs.get(s);
      this.cache.set(s, recs.get(s)!);
    }
    await this.store.set(items);
  }

  async set(id: string, value: T): Promise<void> {
    await this.setMany([[id, value]]);
  }

  async delete(id: string): Promise<void> {
    await this.setMany([[id, undefined]]);
  }

  async all(): Promise<Map<string, T>> {
    const recs = await this.preload(Array.from({ length: this.shards }, (_, i) => i));
    const out = new Map<string, T>();
    for (const rec of recs.values()) for (const [k, v] of Object.entries(rec)) out.set(k, v);
    return out;
  }

  async clear(): Promise<void> {
    this.cache.clear();
    await this.store.remove(Array.from({ length: this.shards }, (_, i) => this.key(i)));
  }

  /** Drop the in-memory cache (e.g. after another context wrote). */
  invalidate(): void {
    this.cache.clear();
  }
}

/** Store a large JSON-serializable value in fixed-size string chunks. */
export async function putChunked(store: KeyValueStore, key: string, value: unknown, chunkChars = 512 * 1024): Promise<number> {
  const json = JSON.stringify(value);
  const n = Math.max(1, Math.ceil(json.length / chunkChars));
  const items: Record<string, unknown> = { [`${key}:meta`]: { chunks: n, length: json.length } };
  for (let i = 0; i < n; i++) items[`${key}:${i}`] = json.slice(i * chunkChars, (i + 1) * chunkChars);
  await store.set(items);
  return json.length;
}

export async function getChunked<T>(store: KeyValueStore, key: string): Promise<T | undefined> {
  const meta = await store.get<{ chunks: number; length: number }>(`${key}:meta`);
  if (!meta) return undefined;
  const keys = Array.from({ length: meta.chunks }, (_, i) => `${key}:${i}`);
  const got = await store.getMany(keys);
  let json = '';
  for (const k of keys) {
    const part = got[k];
    if (typeof part !== 'string') throw new Error(`Missing chunk ${k}`);
    json += part;
  }
  if (json.length !== meta.length) throw new Error(`Chunked value ${key} length mismatch`);
  return JSON.parse(json) as T;
}

export async function removeChunked(store: KeyValueStore, key: string): Promise<void> {
  const meta = await store.get<{ chunks: number }>(`${key}:meta`);
  const keys = [`${key}:meta`];
  if (meta) for (let i = 0; i < meta.chunks; i++) keys.push(`${key}:${i}`);
  await store.remove(keys);
}

/** Random id (not security-sensitive). */
export function newId(prefix = ''): string {
  const rnd = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().replace(/-/g, '').slice(0, 16) : Math.random().toString(36).slice(2, 18);
  return `${prefix}${Date.now().toString(36)}${rnd}`;
}
