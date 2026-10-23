/**
 * In-memory fakes of chrome.bookmarks and chrome.storage.local that model
 * the constraints LinkSpruce relies on: fixed root folders discovered via
 * folderType, managed (unmodifiable) nodes, non-recursive remove() of
 * non-empty folders failing, move-into-descendant failing, events, and
 * injectable failures for crash/quota tests.
 */
import type { BmNode, BookmarksApi, CreateDetails, KeyValueStore } from '../../src/core/platform.ts';

type Listener<A extends unknown[]> = (...args: A) => void;

class Emitter<A extends unknown[]> {
  private ls: Listener<A>[] = [];
  addListener(l: Listener<A>) {
    this.ls.push(l);
  }
  removeListener(l: Listener<A>) {
    this.ls = this.ls.filter((x) => x !== l);
  }
  emit(...a: A) {
    for (const l of [...this.ls]) l(...a);
  }
}

interface Rec {
  id: string;
  parentId?: string;
  title: string;
  url?: string;
  dateAdded: number;
  dateGroupModified?: number;
  folderType?: string;
  unmodifiable?: string;
  children?: string[];
}

export class FakeBookmarks implements BookmarksApi {
  private nodes = new Map<string, Rec>();
  private seq = 100;
  now = 1_700_000_000_000;
  readonly onCreated = new Emitter<[string, BmNode]>();
  readonly onRemoved = new Emitter<[string, { parentId: string; index: number; node: BmNode }]>();
  readonly onChanged = new Emitter<[string, { title: string; url?: string }]>();
  readonly onMoved = new Emitter<[string, { parentId: string; index: number; oldParentId: string; oldIndex: number }]>();
  /** Fail the next call of a method with an error (once). */
  failures = new Map<string, Error>();
  /** Called after a mutation is applied but before the promise resolves (crash simulation). */
  afterMutation: ((method: string, node: BmNode) => void) | null = null;
  calls: Array<{ method: string; args: unknown[] }> = [];

  constructor(opts: { managed?: boolean } = {}) {
    this.nodes.set('0', { id: '0', title: '', dateAdded: this.now, children: ['1', '2', '3'] });
    this.nodes.set('1', { id: '1', parentId: '0', title: 'Bookmarks bar', dateAdded: this.now, folderType: 'bookmarks-bar', children: [] });
    this.nodes.set('2', { id: '2', parentId: '0', title: 'Other bookmarks', dateAdded: this.now, folderType: 'other', children: [] });
    this.nodes.set('3', { id: '3', parentId: '0', title: 'Mobile bookmarks', dateAdded: this.now, folderType: 'mobile', children: [] });
    if (opts.managed) {
      this.nodes.get('0')!.children!.push('4');
      this.nodes.set('4', { id: '4', parentId: '0', title: 'Managed', dateAdded: this.now, folderType: 'managed', unmodifiable: 'managed', children: [] });
      this.nodes.set('5', { id: '5', parentId: '4', title: 'Intranet', url: 'https://intranet.example/', dateAdded: this.now, unmodifiable: 'managed' });
      this.nodes.get('4')!.children!.push('5');
    }
  }

  private fail(method: string) {
    this.calls.push({ method, args: [] });
    const e = this.failures.get(method);
    if (e) {
      this.failures.delete(method);
      throw e;
    }
  }

  private toNode(r: Rec, deep: boolean): BmNode {
    const parent = r.parentId ? this.nodes.get(r.parentId) : undefined;
    const n: BmNode = { id: r.id, title: r.title, dateAdded: r.dateAdded, syncing: false };
    if (r.parentId !== undefined) n.parentId = r.parentId;
    if (parent) n.index = parent.children!.indexOf(r.id);
    if (r.url !== undefined) n.url = r.url;
    if (r.folderType) n.folderType = r.folderType;
    if (r.unmodifiable) n.unmodifiable = r.unmodifiable;
    if (r.children) {
      n.dateGroupModified = r.dateGroupModified ?? r.dateAdded;
      if (deep) n.children = r.children.map((c) => this.toNode(this.nodes.get(c)!, true));
    }
    return n;
  }

  private req(id: string): Rec {
    const r = this.nodes.get(id);
    if (!r) throw new Error("Can't find bookmark for id.");
    return r;
  }

  private isFixed(r: Rec): boolean {
    return r.id === '0' || r.parentId === '0';
  }

  async getTree(): Promise<BmNode[]> {
    this.fail('getTree');
    return [this.toNode(this.req('0'), true)];
  }
  async getSubTree(id: string): Promise<BmNode[]> {
    this.fail('getSubTree');
    return [this.toNode(this.req(id), true)];
  }
  async get(ids: string | string[]): Promise<BmNode[]> {
    this.fail('get');
    const list = Array.isArray(ids) ? ids : [ids];
    return list.map((id) => this.toNode(this.req(id), false));
  }
  async getChildren(id: string): Promise<BmNode[]> {
    this.fail('getChildren');
    const r = this.req(id);
    if (!r.children) return [];
    return r.children.map((c) => this.toNode(this.nodes.get(c)!, false));
  }

  async create(d: CreateDetails): Promise<BmNode> {
    this.fail('create');
    const parentId = d.parentId ?? '2';
    const parent = this.req(parentId);
    if (!parent.children) throw new Error('Parent is not a folder.');
    if (parentId === '0') throw new Error("Can't modify the root bookmark folders.");
    if (parent.unmodifiable) throw new Error("Can't modify managed bookmarks.");
    const id = String(++this.seq);
    const rec: Rec = { id, parentId, title: d.title ?? '', dateAdded: (this.now += 1000) };
    if (d.url !== undefined) {
      try {
        new URL(d.url);
      } catch {
        throw new Error('Invalid URL.');
      }
      rec.url = d.url;
    } else rec.children = [];
    this.nodes.set(id, rec);
    if (d.index !== undefined && (d.index < 0 || d.index > parent.children.length)) throw new Error('Index out of bounds.');
    const index = d.index === undefined ? parent.children.length : d.index;
    parent.children.splice(index, 0, id);
    parent.dateGroupModified = this.now;
    const node = this.toNode(rec, false);
    this.afterMutation?.('create', node);
    this.onCreated.emit(id, node);
    return node;
  }

  async move(id: string, dest: { parentId?: string; index?: number }): Promise<BmNode> {
    this.fail('move');
    const r = this.req(id);
    if (this.isFixed(r)) throw new Error("Can't modify the root bookmark folders.");
    if (r.unmodifiable) throw new Error("Can't modify managed bookmarks.");
    const oldParent = this.req(r.parentId!);
    const newParent = this.req(dest.parentId ?? r.parentId!);
    if (!newParent.children || newParent.id === '0') throw new Error('Invalid destination.');
    if (newParent.unmodifiable) throw new Error("Can't modify managed bookmarks.");
    for (let p: Rec | undefined = newParent; p; p = p.parentId ? this.nodes.get(p.parentId) : undefined) {
      if (p.id === id) throw new Error("Can't move a folder into its own descendant.");
    }
    const oldIndex = oldParent.children!.indexOf(id);
    // Chrome validates the index against the destination's current child count.
    if (dest.index !== undefined && (dest.index < 0 || dest.index > newParent.children.length)) throw new Error('Index out of bounds.');
    oldParent.children!.splice(oldIndex, 1);
    let index = dest.index === undefined ? newParent.children.length : Math.min(dest.index, newParent.children.length);
    // Chrome semantics: index refers to position before removal when moving within the same parent.
    if (newParent === oldParent && dest.index !== undefined && dest.index > oldIndex) index = Math.max(0, index - 1);
    newParent.children.splice(index, 0, id);
    r.parentId = newParent.id;
    const node = this.toNode(r, false);
    this.afterMutation?.('move', node);
    this.onMoved.emit(id, { parentId: newParent.id, index: newParent.children.indexOf(id), oldParentId: oldParent.id, oldIndex });
    return node;
  }

  async update(id: string, changes: { title?: string; url?: string }): Promise<BmNode> {
    this.fail('update');
    const r = this.req(id);
    if (this.isFixed(r) || r.unmodifiable) throw new Error("Can't modify this bookmark.");
    if (changes.title !== undefined) r.title = changes.title;
    if (changes.url !== undefined) {
      if (!r.url) throw new Error("Can't set URL of a bookmark folder.");
      r.url = changes.url;
    }
    const node = this.toNode(r, false);
    this.afterMutation?.('update', node);
    this.onChanged.emit(id, r.url !== undefined ? { title: r.title, url: r.url } : { title: r.title });
    return node;
  }

  async remove(id: string): Promise<void> {
    this.fail('remove');
    const r = this.req(id);
    if (r.children && r.children.length) throw new Error("Can't remove non-empty folder (use recursive to force).");
    this.removeInner(r);
  }
  async removeTree(id: string): Promise<void> {
    this.fail('removeTree');
    this.removeInner(this.req(id));
  }
  private removeInner(r: Rec) {
    if (this.isFixed(r)) throw new Error("Can't modify the root bookmark folders.");
    if (r.unmodifiable) throw new Error("Can't modify managed bookmarks.");
    const parent = this.req(r.parentId!);
    const index = parent.children!.indexOf(r.id);
    const node = this.toNode(r, true);
    parent.children!.splice(index, 1);
    const drop = (x: Rec) => {
      for (const c of x.children ?? []) drop(this.nodes.get(c)!);
      this.nodes.delete(x.id);
    };
    drop(r);
    this.afterMutation?.('remove', node);
    this.onRemoved.emit(r.id, { parentId: parent.id, index, node });
  }

  // ---- test conveniences ----
  /** Create a folder path under a root (default Other bookmarks), returning the leaf id. */
  async ensurePath(path: string[], rootId = '2'): Promise<string> {
    let cur = rootId;
    for (const name of path) {
      const kids = await this.getChildren(cur);
      const hit = kids.find((k) => !k.url && k.title === name);
      cur = hit ? hit.id : (await this.create({ parentId: cur, title: name })).id;
    }
    return cur;
  }
  count(): { bookmarks: number; folders: number } {
    let b = 0;
    let f = 0;
    for (const r of this.nodes.values()) {
      if (r.url !== undefined) b++;
      else f++;
    }
    return { bookmarks: b, folders: f };
  }
  pathOf(id: string): string[] {
    const out: string[] = [];
    let r = this.nodes.get(id);
    while (r?.parentId && r.parentId !== '0') {
      r = this.nodes.get(r.parentId);
      if (r) out.unshift(r.title);
    }
    return out;
  }
  has(id: string): boolean {
    return this.nodes.has(id);
  }
}

export class FakeStore implements KeyValueStore {
  data = new Map<string, string>();
  /** Throw on the next set() (e.g. quota). */
  failNextSet: Error | null = null;
  failSetWhen: ((items: Record<string, unknown>) => boolean) | null = null;
  setCount = 0;

  async get<T>(key: string): Promise<T | undefined> {
    const v = this.data.get(key);
    return v === undefined ? undefined : (JSON.parse(v) as T);
  }
  async getMany(keys: string[]): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    for (const k of keys) {
      const v = this.data.get(k);
      if (v !== undefined) out[k] = JSON.parse(v);
    }
    return out;
  }
  async set(items: Record<string, unknown>): Promise<void> {
    if (this.failNextSet) {
      const e = this.failNextSet;
      this.failNextSet = null;
      throw e;
    }
    if (this.failSetWhen?.(items)) throw new Error('QUOTA_BYTES quota exceeded');
    this.setCount++;
    for (const [k, v] of Object.entries(items)) {
      if (v === undefined) this.data.delete(k);
      else this.data.set(k, JSON.stringify(v));
    }
  }
  async remove(keys: string | string[]): Promise<void> {
    for (const k of Array.isArray(keys) ? keys : [keys]) this.data.delete(k);
  }
  async keys(prefix = ''): Promise<string[]> {
    return [...this.data.keys()].filter((k) => k.startsWith(prefix));
  }
  bytes(): number {
    let n = 0;
    for (const [k, v] of this.data) n += k.length + v.length;
    return n;
  }
}

export class ManualClock {
  t: number;
  constructor(t = 1_700_000_000_000) {
    this.t = t;
  }
  now = () => this.t;
  advance(ms: number) {
    this.t += ms;
  }
}
