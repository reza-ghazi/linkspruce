/**
 * Organization planning: turns resolved assignments into a previewable plan
 * of folder creations and moves beneath a LinkSpruce folder inside a
 * user-selected writable root.
 *
 * Generated folders are reused deterministically: first via the persisted
 * categoryId → folderId map, then by an equivalent name under the expected
 * parent. Re-applying a plan therefore never creates a duplicate tree.
 * A plan records the taxonomy version and a fingerprint of every affected
 * bookmark; applying a plan whose inputs changed is refused or the changed
 * steps are skipped as conflicts.
 */
import type { Assignment, Band } from './classify/classifier.ts';
import type { ParentRef, Step } from './journal.ts';
import type { BmNode } from './platform.ts';
import { byId, displayName, pathOf, type Taxonomy } from './taxonomy/taxonomy.ts';
import { foldText, hashString } from './text.ts';
import type { FlatTree } from './tree.ts';

export const GENERATED_ROOT_NAME = 'LinkSpruce';

export interface FolderMapEntry {
  folderId: string;
  categoryId: string;
  name: string;
}

export interface PlanSettings {
  destinationRootId: string;
  rootFolderName: string;
  includeBands: Band[];
  /** Bookmarks outside these folders are not moved (empty = everything). */
  scopeFolderIds: string[];
  protectedFolderIds: string[];
  /** Skip bookmarks already inside the generated root. */
  skipAlreadyOrganized: boolean;
}

export interface PlannedFolder {
  categoryId: string;
  path: string[];
  existingId?: string | undefined;
  ref: string;
  parentRef: ParentRef;
}

export interface PlannedMove {
  bookmarkId: string;
  title: string;
  url: string;
  fromParentId: string;
  fromPath: string[];
  categoryId: string;
  band: Band | null;
  rationale: string;
}

export interface OrganizePlan {
  id: string;
  createdAt: number;
  taxonomyId: string;
  taxonomyVersion: number;
  fingerprint: string;
  generatedRoot: { existingId?: string | undefined; parentId: string; name: string };
  folders: PlannedFolder[];
  moves: PlannedMove[];
  skipped: Record<'protected' | 'unresolved' | 'band' | 'out-of-scope' | 'already-there' | 'managed' | 'stale', number>;
  unresolvedIds: string[];
}

export class PlanError extends Error {}

function childFolders(tree: BmNode, parentId: string): BmNode[] {
  const find = (n: BmNode): BmNode | undefined => {
    if (n.id === parentId) return n;
    for (const c of n.children ?? []) {
      const r = find(c);
      if (r) return r;
    }
    return undefined;
  };
  return (find(tree)?.children ?? []).filter((c) => c.url === undefined);
}

export function planFingerprint(taxonomyVersion: number, moves: readonly PlannedMove[]): string {
  const rows = moves.map((m) => `${m.bookmarkId}|${m.fromParentId}|${m.categoryId}|${m.url}`).sort();
  return hashString(`${taxonomyVersion}\n${rows.join('\n')}`);
}

export function buildOrganizePlan(args: {
  tree: BmNode;
  flat: FlatTree;
  taxonomy: Taxonomy;
  assignments: ReadonlyMap<string, Assignment>;
  folderMap: ReadonlyMap<string, FolderMapEntry>;
  settings: PlanSettings;
  now: number;
  id: string;
}): OrganizePlan {
  const { tree, flat, taxonomy, assignments, folderMap, settings } = args;
  const dest = flat.byId.get(settings.destinationRootId);
  const destIsPermanent = (tree.children ?? []).some((c) => c.id === settings.destinationRootId);
  if (!destIsPermanent && (!dest || 'url' in dest)) throw new PlanError('Destination folder not found');
  if (dest && !dest.writable) throw new PlanError('Destination folder is read-only (managed)');

  // Generated root: reuse an existing folder with the configured name under the destination.
  const rootName = settings.rootFolderName.trim() || GENERATED_ROOT_NAME;
  const existingRoot = childFolders(tree, settings.destinationRootId).find((c) => foldText(c.title) === foldText(rootName));
  const generatedRootRef: ParentRef = existingRoot ? { id: existingRoot.id } : { ref: 'root' };
  const generatedRootId = existingRoot?.id;

  const cats = byId(taxonomy);
  const folders: PlannedFolder[] = [];
  const folderRef = new Map<string, ParentRef>();
  const existingFolderIds = new Set(flat.folders.map((f) => f.id));

  const ensureFolder = (categoryId: string): ParentRef => {
    const cached = folderRef.get(categoryId);
    if (cached) return cached;
    const cat = cats.get(categoryId);
    if (!cat) throw new PlanError(`Unknown category ${categoryId}`);
    const parentRef = cat.parentId ? ensureFolder(cat.parentId) : generatedRootRef;
    const name = displayName(taxonomy, cat).slice(0, 120);
    let existingId: string | undefined;
    const mapped = folderMap.get(categoryId);
    const parentId = 'id' in parentRef ? parentRef.id : undefined;
    if (mapped && existingFolderIds.has(mapped.folderId)) {
      const f = flat.byId.get(mapped.folderId);
      // Only reuse if it still sits under the expected parent.
      if (f && f.parentId === parentId) existingId = mapped.folderId;
    }
    if (!existingId && parentId) {
      const hit = childFolders(tree, parentId).find((c) => foldText(c.title) === foldText(name) || foldText(c.title) === foldText(cat.name));
      if (hit) existingId = hit.id;
    }
    const ref = `c:${categoryId}`;
    const pf: PlannedFolder = { categoryId, path: pathOf(taxonomy, categoryId).map((c) => displayName(taxonomy, c)), existingId, ref, parentRef };
    folders.push(pf);
    const out: ParentRef = existingId ? { id: existingId } : { ref };
    folderRef.set(categoryId, out);
    return out;
  };

  const skipped: OrganizePlan['skipped'] = { protected: 0, unresolved: 0, band: 0, 'out-of-scope': 0, 'already-there': 0, managed: 0, stale: 0 };
  const unresolvedIds: string[] = [];
  const moves: PlannedMove[] = [];
  const scope = new Set(settings.scopeFolderIds);
  const prot = new Set(settings.protectedFolderIds);
  for (const b of flat.bookmarks) {
    if (!b.writable) {
      skipped.managed++;
      continue;
    }
    if (scope.size && !b.pathIds.some((p) => scope.has(p)) && !scope.has(b.parentId)) {
      skipped['out-of-scope']++;
      continue;
    }
    if (b.pathIds.some((p) => prot.has(p)) || prot.has(b.parentId)) {
      skipped.protected++;
      continue;
    }
    if (settings.skipAlreadyOrganized && generatedRootId && b.pathIds.includes(generatedRootId)) {
      // Still allow corrections of bookmarks in the wrong generated folder.
      const mappedParent = [...folderMap.values()].find((m) => m.folderId === b.parentId);
      const a = assignments.get(b.id);
      if (!a?.categoryId || mappedParent?.categoryId === a.categoryId) {
        skipped['already-there']++;
        continue;
      }
    }
    const a = assignments.get(b.id);
    if (!a || a.categoryId === null) {
      if (a?.provider === 'protected') skipped.protected++;
      else {
        skipped.unresolved++;
        unresolvedIds.push(b.id);
      }
      continue;
    }
    if (a.provider !== 'user' && a.provider !== 'user-rule' && (!a.band || !settings.includeBands.includes(a.band) || a.needsReview)) {
      skipped.band++;
      unresolvedIds.push(b.id);
      continue;
    }
    if (!cats.get(a.categoryId) || cats.get(a.categoryId)!.status !== 'active') {
      skipped.stale++;
      continue;
    }
    const target = ensureFolder(a.categoryId);
    if ('id' in target && target.id === b.parentId) {
      skipped['already-there']++;
      continue;
    }
    moves.push({ bookmarkId: b.id, title: b.title, url: b.url, fromParentId: b.parentId, fromPath: b.path, categoryId: a.categoryId, band: a.band, rationale: a.rationale });
  }
  // Keep only folders on the path of at least one move (no empty generated folders).
  const needed = new Set<string>();
  for (const m of moves) for (const c of pathOf(taxonomy, m.categoryId)) needed.add(c.id);
  const usedFolders = folders.filter((f) => needed.has(f.categoryId));
  return {
    id: args.id,
    createdAt: args.now,
    taxonomyId: taxonomy.id,
    taxonomyVersion: taxonomy.version,
    fingerprint: planFingerprint(taxonomy.version, moves),
    generatedRoot: { existingId: existingRoot?.id, parentId: settings.destinationRootId, name: rootName },
    folders: usedFolders,
    moves,
    skipped,
    unresolvedIds,
  };
}

/** Convert a plan to journal steps (folders top-down, then moves grouped by destination). */
export function planToSteps(plan: OrganizePlan): Step[] {
  const steps: Step[] = [];
  if (!plan.generatedRoot.existingId && plan.moves.length) {
    steps.push({ op: 'create', ref: 'root', parent: { id: plan.generatedRoot.parentId }, title: plan.generatedRoot.name, generated: true });
  }
  const depth = (f: PlannedFolder) => f.path.length;
  for (const f of [...plan.folders].sort((a, b) => depth(a) - depth(b))) {
    if (f.existingId) continue;
    steps.push({ op: 'create', ref: f.ref, parent: f.parentRef, title: f.path[f.path.length - 1]!, generated: true });
  }
  const refOf = new Map(plan.folders.map((f) => [f.categoryId, f.existingId ? ({ id: f.existingId } as ParentRef) : ({ ref: f.ref } as ParentRef)]));
  const sorted = [...plan.moves].sort((a, b) => a.categoryId.localeCompare(b.categoryId));
  for (const m of sorted) {
    steps.push({ op: 'move', id: m.bookmarkId, to: refOf.get(m.categoryId)!, expect: { parentId: m.fromParentId, url: m.url } });
  }
  return steps;
}

/** After applying, record categoryId → folderId for deterministic reuse. */
export function folderMapFromResults(plan: OrganizePlan, steps: Step[], rids: ReadonlyArray<string | undefined>): FolderMapEntry[] {
  const out: FolderMapEntry[] = [];
  for (const f of plan.folders) {
    if (f.existingId) {
      out.push({ categoryId: f.categoryId, folderId: f.existingId, name: f.path[f.path.length - 1]! });
      continue;
    }
    const i = steps.findIndex((s) => s.op === 'create' && s.ref === f.ref);
    const rid = i >= 0 ? rids[i] : undefined;
    if (rid) out.push({ categoryId: f.categoryId, folderId: rid, name: f.path[f.path.length - 1]! });
  }
  return out;
}

/** True if a stored plan can still be applied to the current taxonomy. */
export function planIsCurrent(plan: OrganizePlan, taxonomy: Taxonomy): boolean {
  return plan.taxonomyId === taxonomy.id && plan.taxonomyVersion === taxonomy.version;
}

/** Duplicate-removal steps for selected bookmark ids (bookmarks only; folders never removed). */
export function dedupeSteps(flat: FlatTree, removeIds: readonly string[]): Step[] {
  const steps: Step[] = [];
  for (const id of removeIds) {
    const b = flat.byId.get(id);
    if (!b || !('url' in b) || !b.writable) continue;
    steps.push({
      op: 'remove',
      id,
      expect: { parentId: b.parentId, title: b.title, url: b.url },
      before: { id, title: b.title, url: b.url, dateAdded: b.dateAdded, parentId: b.parentId, index: b.index },
    });
  }
  return steps;
}
