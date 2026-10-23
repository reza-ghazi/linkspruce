/**
 * Read-only access to LinkSpruce state from extension pages. Pages read
 * chrome.storage and chrome.bookmarks directly for speed but never mutate
 * bookmarks or background-owned state: every change goes through a
 * validated message to the background service worker.
 */
import type { ActivityEntry, QueueItem } from '../../core/autofile.ts';
import type { SnapshotMeta } from '../../core/backup.ts';
import type { JobState } from '../../core/jobs.ts';
import type { BatchHeader } from '../../core/journal.ts';
import type { BmNode } from '../../core/platform.ts';
import { Repo } from '../../core/repo.ts';
import type { Settings } from '../../core/settings.ts';
import type { Taxonomy } from '../../core/taxonomy/taxonomy.ts';
import { flattenTree, discoverRoots, type FlatTree, type Roots } from '../../core/tree.ts';
import { chromeStore } from '../../background/chrome-platform.ts';

export const store = chromeStore();
export const repo = new Repo(store, { now: () => Date.now() });

export interface TreeData {
  root: BmNode;
  flat: FlatTree;
  roots: Roots;
}

export async function loadTree(): Promise<TreeData> {
  const [root] = (await chrome.bookmarks.getTree()) as BmNode[];
  return { root: root!, flat: flattenTree(root!), roots: discoverRoots(root!) };
}

export async function jobs(): Promise<{ audit?: JobState; classify?: JobState; discover?: JobState }> {
  const got = await store.getMany(['job:audit', 'job:classify', 'job:discover']);
  return { audit: got['job:audit'] as JobState | undefined, classify: got['job:classify'] as JobState | undefined, discover: got['job:discover'] as JobState | undefined };
}

export async function settings(): Promise<Settings> {
  return repo.settings();
}

export async function taxonomy(): Promise<Taxonomy | undefined> {
  return repo.taxonomy();
}

export async function batches(): Promise<BatchHeader[]> {
  return ((await store.get<BatchHeader[]>('journal:index')) ?? []).sort((a, b) => b.createdAt - a.createdAt);
}

export async function snapshots(): Promise<SnapshotMeta[]> {
  return ((await store.get<SnapshotMeta[]>('snapshot:index')) ?? []).sort((a, b) => b.createdAt - a.createdAt);
}

export async function activity(): Promise<ActivityEntry[]> {
  return (await store.get<ActivityEntry[]>('autofile:activity')) ?? [];
}

export async function autofileQueue(): Promise<Record<string, QueueItem>> {
  return (await store.get<Record<string, QueueItem>>('autofile:queue')) ?? {};
}

export async function hasBroadHostAccess(): Promise<boolean> {
  return chrome.permissions.contains({ origins: ['https://*/*', 'http://*/*'] });
}

/** Subscribe to storage changes; caches are invalidated before the callback. */
export function onStateChange(cb: (keys: string[]) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const keys = Object.keys(changes);
    if (keys.some((k) => k.startsWith('as:'))) repo.assignments.invalidate();
    if (keys.some((k) => k.startsWith('hl:'))) repo.health.invalidate();
    if (keys.some((k) => k.startsWith('ov:'))) repo.overrides.invalidate();
    cb(keys);
  });
  chrome.bookmarks.onChanged.addListener(() => cb(['bookmarks']));
  chrome.bookmarks.onCreated.addListener(() => cb(['bookmarks']));
  chrome.bookmarks.onRemoved.addListener(() => cb(['bookmarks']));
  chrome.bookmarks.onMoved.addListener(() => cb(['bookmarks']));
}
