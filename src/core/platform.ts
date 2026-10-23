/**
 * Thin abstractions over the Chrome APIs LinkSpruce depends on. Core modules
 * only see these interfaces so they can be exercised in Node against
 * in-memory fakes (tests/helpers/fake-chrome.ts) and in the browser against
 * the real chrome.* implementations (src/background/chrome-platform.ts).
 */

export interface BmNode {
  id: string;
  parentId?: string | undefined;
  index?: number | undefined;
  title: string;
  url?: string | undefined;
  dateAdded?: number | undefined;
  dateGroupModified?: number | undefined;
  dateLastUsed?: number | undefined;
  /** Chrome 134+: bookmarks-bar | other | mobile | managed. */
  folderType?: string | undefined;
  unmodifiable?: string | undefined;
  syncing?: boolean | undefined;
  children?: BmNode[] | undefined;
}

export interface CreateDetails {
  parentId?: string;
  index?: number;
  title?: string;
  url?: string;
}

export interface BookmarksApi {
  getTree(): Promise<BmNode[]>;
  getSubTree(id: string): Promise<BmNode[]>;
  get(idOrIds: string | string[]): Promise<BmNode[]>;
  getChildren(id: string): Promise<BmNode[]>;
  create(details: CreateDetails): Promise<BmNode>;
  move(id: string, destination: { parentId?: string; index?: number }): Promise<BmNode>;
  update(id: string, changes: { title?: string; url?: string }): Promise<BmNode>;
  remove(id: string): Promise<void>;
  removeTree(id: string): Promise<void>;
}

export interface KeyValueStore {
  get<T>(key: string): Promise<T | undefined>;
  getMany(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
  /** All keys with the given prefix. */
  keys(prefix?: string): Promise<string[]>;
}

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
