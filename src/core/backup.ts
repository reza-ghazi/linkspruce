/**
 * Snapshots, JSON backups and restore validation.
 *
 * Backup files contain hierarchy, order, titles, URLs and available dates,
 * plus LinkSpruce tags/facets when requested. They never contain API keys,
 * tokens or fetched page content. Bookmarks themselves can contain private
 * URLs, so backups should be stored with care.
 */
import { parseNetscapeBookmarks, type ImportedNode } from './netscape.ts';
import type { BmNode, BookmarksApi, Clock, KeyValueStore } from './platform.ts';
import { getChunked, newId, putChunked, removeChunked } from './store.ts';

export const BACKUP_FORMAT = 'linkspruce-backup';
export const BACKUP_SCHEMA = 1;

export interface SnapNode {
  id?: string | undefined;
  title: string;
  url?: string | undefined;
  dateAdded?: number | undefined;
  folderType?: string | undefined;
  children?: SnapNode[] | undefined;
}

export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  schemaVersion: number;
  exportedAt: string;
  app: { name: 'LinkSpruce'; version: string };
  notice: string;
  counts: { bookmarks: number; folders: number };
  root: SnapNode;
  /** Optional LinkSpruce metadata keyed by bookmark id at export time. */
  metadata?: { tags?: Record<string, string[]>; taxonomyId?: string } | undefined;
}

export function toSnap(n: BmNode): SnapNode {
  const s: SnapNode = { id: n.id, title: n.title };
  if (n.url !== undefined) s.url = n.url;
  if (n.dateAdded !== undefined) s.dateAdded = n.dateAdded;
  if (n.folderType) s.folderType = n.folderType;
  if (n.children) s.children = n.children.map(toSnap);
  return s;
}

export function countSnap(n: SnapNode): { bookmarks: number; folders: number; maxDepth: number; nodes: number } {
  let bookmarks = 0;
  let folders = 0;
  let maxDepth = 0;
  let nodes = 0;
  const walk = (x: SnapNode, d: number) => {
    nodes++;
    maxDepth = Math.max(maxDepth, d);
    for (const c of x.children ?? []) {
      if (c.url !== undefined) {
        bookmarks++;
        nodes++;
      } else {
        folders++;
        walk(c, d + 1);
      }
    }
  };
  walk(n, 0);
  return { bookmarks, folders, maxDepth, nodes };
}

export interface SnapshotMeta {
  id: string;
  createdAt: number;
  reason: string;
  bookmarks: number;
  folders: number;
  bytes: number;
  batchId?: string | undefined;
}

export interface SnapshotStoreOptions {
  maxSnapshots: number;
  maxTotalBytes: number;
}

export const DEFAULT_SNAPSHOT_RETENTION: SnapshotStoreOptions = { maxSnapshots: 12, maxTotalBytes: 120 * 1024 * 1024 };

export class SnapshotError extends Error {}

/** Full-tree snapshots, verified by read-back before any bulk mutation proceeds. */
export class SnapshotStore {
  private readonly store: KeyValueStore;
  private readonly clock: Clock;
  readonly opts: SnapshotStoreOptions;

  constructor(store: KeyValueStore, clock: Clock, opts: SnapshotStoreOptions = DEFAULT_SNAPSHOT_RETENTION) {
    this.store = store;
    this.clock = clock;
    this.opts = opts;
  }

  async list(): Promise<SnapshotMeta[]> {
    return (await this.store.get<SnapshotMeta[]>('snapshot:index')) ?? [];
  }

  /** Capture the live tree, store it, read it back and verify counts. Throws SnapshotError on any failure. */
  async capture(api: BookmarksApi, reason: string, batchId?: string): Promise<SnapshotMeta> {
    const [root] = await api.getTree();
    if (!root) throw new SnapshotError('Could not read the bookmark tree');
    const tree = toSnap(root);
    const counts = countSnap(tree);
    const id = newId('snap_');
    let bytes: number;
    try {
      bytes = await putChunked(this.store, `snapshot:${id}`, tree);
      const back = await getChunked<SnapNode>(this.store, `snapshot:${id}`);
      if (!back) throw new Error('read-back returned nothing');
      const c2 = countSnap(back);
      if (c2.bookmarks !== counts.bookmarks || c2.folders !== counts.folders) throw new Error('read-back counts differ');
    } catch (e) {
      await removeChunked(this.store, `snapshot:${id}`).catch(() => undefined);
      throw new SnapshotError(`Backup snapshot could not be saved and verified: ${(e as Error).message}`);
    }
    const meta: SnapshotMeta = { id, createdAt: this.clock.now(), reason, bookmarks: counts.bookmarks, folders: counts.folders, bytes, batchId };
    const index = [...(await this.list()), meta];
    try {
      await this.store.set({ 'snapshot:index': index });
    } catch (e) {
      await removeChunked(this.store, `snapshot:${id}`).catch(() => undefined);
      throw new SnapshotError(`Snapshot index could not be updated: ${(e as Error).message}`);
    }
    await this.enforceRetention(id);
    return meta;
  }

  async get(id: string): Promise<SnapNode | undefined> {
    return getChunked<SnapNode>(this.store, `snapshot:${id}`);
  }

  async delete(id: string): Promise<void> {
    await removeChunked(this.store, `snapshot:${id}`);
    await this.store.set({ 'snapshot:index': (await this.list()).filter((m) => m.id !== id) });
  }

  /** Keep the newest snapshots within count/bytes limits; never delete `keepId`. */
  async enforceRetention(keepId?: string): Promise<string[]> {
    const index = (await this.list()).sort((a, b) => b.createdAt - a.createdAt);
    const pinned = index.find((m) => m.id === keepId);
    const keep: SnapshotMeta[] = pinned ? [pinned] : [];
    const drop: SnapshotMeta[] = [];
    let bytes = pinned?.bytes ?? 0;
    for (const m of index) {
      if (m === pinned) continue;
      if (keep.length < this.opts.maxSnapshots && bytes + m.bytes <= this.opts.maxTotalBytes) {
        keep.push(m);
        bytes += m.bytes;
      } else drop.push(m);
    }
    for (const m of drop) await removeChunked(this.store, `snapshot:${m.id}`);
    if (drop.length) await this.store.set({ 'snapshot:index': keep.sort((a, b) => a.createdAt - b.createdAt) });
    return drop.map((m) => m.id);
  }
}

export function makeBackupFile(root: SnapNode, appVersion: string, now: Date, metadata?: BackupFile['metadata']): BackupFile {
  const c = countSnap(root);
  const file: BackupFile = {
    format: BACKUP_FORMAT,
    schemaVersion: BACKUP_SCHEMA,
    exportedAt: now.toISOString(),
    app: { name: 'LinkSpruce', version: appVersion },
    notice: 'Contains your bookmark titles and URLs, which may include private links. Contains no API keys or passwords.',
    counts: { bookmarks: c.bookmarks, folders: c.folders },
    root,
  };
  if (metadata) file.metadata = metadata;
  return file;
}

export function backupFilename(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `linkspruce-backup-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}.json`;
}

export interface RestoreLimits {
  maxBytes: number;
  maxNodes: number;
  maxDepth: number;
  allowScriptUrls: boolean;
}

export const DEFAULT_RESTORE_LIMITS: RestoreLimits = { maxBytes: 64 * 1024 * 1024, maxNodes: 250_000, maxDepth: 64, allowScriptUrls: false };

export interface RestoreValidation {
  ok: boolean;
  source: 'linkspruce-json' | 'netscape-html' | 'unknown';
  root?: SnapNode | undefined;
  counts?: { bookmarks: number; folders: number; maxDepth: number } | undefined;
  errors: string[];
  warnings: string[];
  skippedUrls: number;
}

const SAFE_SCHEMES = /^(https?|ftp|file|chrome|edge|about|mailto|tel):/i;
const SCRIPT_SCHEMES = /^(javascript|data|vbscript):/i;

function sanitizeSnap(n: unknown, depth: number, limits: RestoreLimits, acc: { nodes: number; skipped: number; errors: string[] }): SnapNode | null {
  if (acc.errors.length) return null;
  if (typeof n !== 'object' || n === null) {
    acc.errors.push('Invalid node');
    return null;
  }
  if (depth > limits.maxDepth) {
    acc.errors.push(`Nesting deeper than ${limits.maxDepth}`);
    return null;
  }
  if (++acc.nodes > limits.maxNodes) {
    acc.errors.push(`More than ${limits.maxNodes} nodes`);
    return null;
  }
  const o = n as Record<string, unknown>;
  const title = typeof o.title === 'string' ? o.title.slice(0, 4096) : '';
  const out: SnapNode = { title };
  if (typeof o.dateAdded === 'number' && Number.isFinite(o.dateAdded)) out.dateAdded = o.dateAdded;
  if (typeof o.url === 'string') {
    const url = o.url.trim();
    let valid = false;
    try {
      new URL(url);
      valid = true;
    } catch {
      valid = false;
    }
    if (!valid || url.length > 65_536) {
      acc.skipped++;
      return null;
    }
    if (SCRIPT_SCHEMES.test(url) && !limits.allowScriptUrls) {
      acc.skipped++;
      return null;
    }
    if (!SAFE_SCHEMES.test(url) && !SCRIPT_SCHEMES.test(url)) {
      acc.skipped++;
      return null;
    }
    out.url = url;
    return out;
  }
  if (o.children !== undefined && !Array.isArray(o.children)) {
    acc.errors.push('Folder children must be a list');
    return null;
  }
  out.children = [];
  for (const c of (o.children as unknown[] | undefined) ?? []) {
    const s = sanitizeSnap(c, depth + 1, limits, acc);
    if (s) out.children.push(s);
    if (acc.errors.length) return null;
  }
  return out;
}

function importedToSnap(n: ImportedNode): SnapNode {
  const s: SnapNode = { title: n.title };
  if (n.dateAdded) s.dateAdded = n.dateAdded;
  if (n.kind === 'bookmark') s.url = n.url ?? '';
  else s.children = (n.children ?? []).map(importedToSnap);
  return s;
}

/** Validate a user-supplied backup (LinkSpruce JSON or bookmarks HTML) before preview. */
export function validateRestoreFile(text: string, limits: RestoreLimits = DEFAULT_RESTORE_LIMITS): RestoreValidation {
  const v: RestoreValidation = { ok: false, source: 'unknown', errors: [], warnings: [], skippedUrls: 0 };
  if (text.length > limits.maxBytes) {
    v.errors.push(`File is larger than ${Math.round(limits.maxBytes / 1048576)} MB`);
    return v;
  }
  const trimmed = text.trimStart();
  let rawRoot: unknown;
  if (trimmed.startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      v.errors.push('File is not valid JSON');
      return v;
    }
    const f = parsed as Partial<BackupFile>;
    if (f.format !== BACKUP_FORMAT) {
      v.errors.push('Not a LinkSpruce backup file');
      return v;
    }
    if (typeof f.schemaVersion !== 'number' || f.schemaVersion > BACKUP_SCHEMA) {
      v.errors.push(`Unsupported backup schema version ${String(f.schemaVersion)}`);
      return v;
    }
    v.source = 'linkspruce-json';
    rawRoot = f.root;
  } else if (/<!DOCTYPE NETSCAPE-Bookmark-file-1>|<DL/i.test(trimmed.slice(0, 4096))) {
    try {
      const r = parseNetscapeBookmarks(text, { maxBytes: limits.maxBytes, maxNodes: limits.maxNodes, maxDepth: limits.maxDepth, maxTitleLength: 4096, maxUrlLength: 65_536 });
      v.source = 'netscape-html';
      v.warnings.push(...r.warnings);
      rawRoot = importedToSnap(r.root);
    } catch (e) {
      v.errors.push((e as Error).message);
      return v;
    }
  } else {
    v.errors.push('Unrecognized file type: expected a LinkSpruce .json backup or a bookmarks .html export');
    return v;
  }
  const acc = { nodes: 0, skipped: 0, errors: [] as string[] };
  const root = sanitizeSnap(rawRoot, 0, limits, acc);
  if (!root || acc.errors.length) {
    v.errors.push(...acc.errors);
    if (!acc.errors.length) v.errors.push('Backup has no root folder');
    return v;
  }
  if (root.url !== undefined) {
    v.errors.push('Backup root must be a folder');
    return v;
  }
  v.skippedUrls = acc.skipped;
  if (acc.skipped) v.warnings.push(`${acc.skipped} item(s) with invalid or script URLs (javascript:, data:) will be skipped.`);
  const c = countSnap(root);
  v.root = root;
  v.counts = { bookmarks: c.bookmarks, folders: c.folders, maxDepth: c.maxDepth };
  v.ok = true;
  return v;
}
