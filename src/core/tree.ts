/** Bookmark-tree helpers: flattening, root discovery, writability. */
import type { BmNode } from './platform.ts';

export interface FlatBookmark {
  id: string;
  parentId: string;
  index: number;
  title: string;
  url: string;
  dateAdded?: number | undefined;
  dateLastUsed?: number | undefined;
  /** Folder titles from the top-level folder down to the parent. */
  path: string[];
  pathIds: string[];
  depth: number;
  writable: boolean;
}

export interface FlatFolder {
  id: string;
  parentId?: string | undefined;
  index: number;
  title: string;
  path: string[];
  pathIds: string[];
  depth: number;
  childCount: number;
  bookmarkCount: number;
  writable: boolean;
  folderType?: string | undefined;
}

export interface FlatTree {
  bookmarks: FlatBookmark[];
  folders: FlatFolder[];
  byId: Map<string, FlatBookmark | FlatFolder>;
}

/** True when the node or any ancestor is managed/unmodifiable, or is the invisible root. */
function nodeWritable(n: BmNode, parentWritable: boolean): boolean {
  if (n.unmodifiable) return false;
  if (n.folderType === 'managed') return false;
  return parentWritable;
}

export function flattenTree(root: BmNode): FlatTree {
  const bookmarks: FlatBookmark[] = [];
  const folders: FlatFolder[] = [];
  const byId = new Map<string, FlatBookmark | FlatFolder>();
  const walk = (n: BmNode, path: string[], pathIds: string[], writable: boolean): number => {
    let count = 0;
    for (const c of n.children ?? []) {
      const w = nodeWritable(c, writable);
      if (c.url !== undefined) {
        const b: FlatBookmark = {
          id: c.id,
          parentId: n.id,
          index: c.index ?? 0,
          title: c.title,
          url: c.url,
          dateAdded: c.dateAdded,
          dateLastUsed: c.dateLastUsed,
          path,
          pathIds,
          depth: path.length,
          writable: w,
        };
        bookmarks.push(b);
        byId.set(b.id, b);
        count++;
      } else {
        const f: FlatFolder = {
          id: c.id,
          parentId: n.id,
          index: c.index ?? 0,
          title: c.title,
          path,
          pathIds,
          depth: path.length,
          childCount: c.children?.length ?? 0,
          bookmarkCount: 0,
          writable: w,
          folderType: c.folderType,
        };
        folders.push(f);
        byId.set(f.id, f);
        f.bookmarkCount = walk(c, [...path, c.title], [...pathIds, c.id], w);
        count += f.bookmarkCount;
      }
    }
    return count;
  };
  walk(root, [], [], true);
  return { bookmarks, folders, byId };
}

export interface Roots {
  bar?: string | undefined;
  other?: string | undefined;
  mobile?: string | undefined;
  managed: string[];
  /** All permanent top-level folders (children of the invisible root). */
  permanent: string[];
}

/**
 * Discover permanent folders from folderType (Chrome 134+), falling back to
 * position for older builds. IDs are never hardcoded.
 */
export function discoverRoots(tree: BmNode): Roots {
  const roots: Roots = { managed: [], permanent: [] };
  const kids = tree.children ?? [];
  kids.forEach((k, i) => {
    roots.permanent.push(k.id);
    const t = k.folderType ?? (k.unmodifiable ? 'managed' : i === 0 ? 'bookmarks-bar' : i === 1 ? 'other' : i === 2 ? 'mobile' : undefined);
    if (t === 'bookmarks-bar') roots.bar ??= k.id;
    else if (t === 'other') roots.other ??= k.id;
    else if (t === 'mobile') roots.mobile ??= k.id;
    else if (t === 'managed') roots.managed.push(k.id);
  });
  return roots;
}

/** Folders a user may choose as the LinkSpruce destination root. */
export function writableFolders(flat: FlatTree): FlatFolder[] {
  return flat.folders.filter((f) => f.writable);
}

/** Find a node in a tree by id. */
export function findNode(root: BmNode, id: string): BmNode | undefined {
  if (root.id === id) return root;
  for (const c of root.children ?? []) {
    const hit = findNode(c, id);
    if (hit) return hit;
  }
  return undefined;
}

/** True if `id` is `ancestorId` or lies beneath it. */
export function isWithin(flat: FlatTree, id: string, ancestorIds: ReadonlySet<string>): boolean {
  if (ancestorIds.has(id)) return true;
  const n = flat.byId.get(id);
  if (!n) return false;
  return n.pathIds.some((p) => ancestorIds.has(p));
}

export function countTree(root: BmNode): { bookmarks: number; folders: number; maxDepth: number } {
  let bookmarks = 0;
  let folders = 0;
  let maxDepth = 0;
  const walk = (n: BmNode, d: number) => {
    maxDepth = Math.max(maxDepth, d);
    for (const c of n.children ?? []) {
      if (c.url !== undefined) bookmarks++;
      else {
        folders++;
        walk(c, d + 1);
      }
    }
  };
  walk(root, 0);
  return { bookmarks, folders, maxDepth };
}
