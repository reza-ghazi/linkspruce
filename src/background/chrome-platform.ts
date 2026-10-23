/** Real chrome.* implementations of the core platform interfaces. */
import type { BmNode, BookmarksApi, CreateDetails, KeyValueStore } from '../core/platform.ts';

export const chromeBookmarks: BookmarksApi = {
  getTree: () => chrome.bookmarks.getTree() as Promise<BmNode[]>,
  getSubTree: (id) => chrome.bookmarks.getSubTree(id) as Promise<BmNode[]>,
  get: (ids) => chrome.bookmarks.get(ids as string | [string, ...string[]]) as Promise<BmNode[]>,
  getChildren: (id) => chrome.bookmarks.getChildren(id) as Promise<BmNode[]>,
  create: (d: CreateDetails) => chrome.bookmarks.create(d) as Promise<BmNode>,
  move: (id, dest) => chrome.bookmarks.move(id, dest) as Promise<BmNode>,
  update: (id, changes) => chrome.bookmarks.update(id, changes) as Promise<BmNode>,
  remove: (id) => chrome.bookmarks.remove(id),
  removeTree: (id) => chrome.bookmarks.removeTree(id),
};

export function chromeStore(area: chrome.storage.StorageArea = chrome.storage.local): KeyValueStore {
  return {
    async get<T>(key: string) {
      const r = await area.get(key);
      return r[key] as T | undefined;
    },
    async getMany(keys: string[]) {
      if (!keys.length) return {};
      return (await area.get(keys)) as Record<string, unknown>;
    },
    async set(items: Record<string, unknown>) {
      await area.set(items);
    },
    async remove(keys: string | string[]) {
      await area.remove(keys);
    },
    async keys(prefix = '') {
      const all = await area.get(null);
      return Object.keys(all).filter((k) => k.startsWith(prefix));
    },
  };
}

/**
 * Gemini key storage. Default: chrome.storage.session (memory only, cleared
 * when the browser closes; restricted to extension pages). Persistent
 * storage is opt-in and disclosed as not being a secure vault. The key is
 * never synced, logged, exported or included in backups.
 */
export const geminiKeyStore = {
  async get(): Promise<string | undefined> {
    const s = await chrome.storage.session.get('secret:gemini');
    if (typeof s['secret:gemini'] === 'string') return s['secret:gemini'];
    const l = await chrome.storage.local.get('secret:gemini');
    return typeof l['secret:gemini'] === 'string' ? l['secret:gemini'] : undefined;
  },
  async set(key: string, persist: boolean): Promise<void> {
    await chrome.storage.session.set({ 'secret:gemini': key });
    if (persist) await chrome.storage.local.set({ 'secret:gemini': key });
    else await chrome.storage.local.remove('secret:gemini');
  },
  async clear(): Promise<void> {
    await chrome.storage.session.remove('secret:gemini');
    await chrome.storage.local.remove('secret:gemini');
  },
  async status(): Promise<{ present: boolean; persisted: boolean }> {
    const l = await chrome.storage.local.get('secret:gemini');
    const s = await chrome.storage.session.get('secret:gemini');
    return { present: typeof s['secret:gemini'] === 'string' || typeof l['secret:gemini'] === 'string', persisted: typeof l['secret:gemini'] === 'string' };
  },
};

export async function hasOrigin(origin: string): Promise<boolean> {
  try {
    return await chrome.permissions.contains({ origins: [origin] });
  } catch {
    return false;
  }
}
