/**
 * Conservative duplicate detection with explicit, tiered evidence.
 *
 * High-confidence groups are built (union-find) only from: identical
 * original URLs, structurally normalized matches, and documented tracking
 * parameter variants. Observed redirect destinations and declared canonical
 * targets produce *pairwise suggestions* only: they never merge clusters
 * transitively, and convergent destinations (login, error or home pages
 * shared by unrelated bookmarks) are discarded.
 */
import type { FlatBookmark } from './tree.ts';
import { siteOf, urlKeys } from './url.ts';

export type EvidenceKind = 'identical' | 'normalized' | 'tracking' | 'redirect' | 'canonical';

export interface Evidence {
  kind: EvidenceKind;
  confidence: 'high' | 'medium' | 'low';
  detail: string;
}

export interface DuplicateGroup {
  id: string;
  /** Bookmark ids, oldest first. */
  members: string[];
  evidence: Evidence[];
  /** Representative comparison key. */
  key: string;
  sameFolder: boolean;
}

export interface DuplicateSuggestion {
  id: string;
  /** Two units; each is a high-confidence group's members or a single bookmark. */
  a: string[];
  b: string[];
  evidence: Evidence[];
  confidence: 'medium' | 'low';
}

export interface LinkSignals {
  finalUrl?: string | undefined;
  redirected?: boolean | undefined;
  canonical?: string | undefined;
  loginOrChallenge?: boolean | undefined;
}

export interface DuplicateReport {
  groups: DuplicateGroup[];
  suggestions: DuplicateSuggestion[];
  convergentDestinations: Array<{ url: string; count: number; reason: string }>;
  stats: { bookmarks: number; inGroups: number; removableIfKeepOne: number };
}

class UnionFind {
  private p = new Map<string, string>();
  find(x: string): string {
    let r = this.p.get(x) ?? x;
    if (r !== x) {
      r = this.find(r);
      this.p.set(x, r);
    }
    return r;
  }
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.p.set(rb, ra);
  }
}

const CONVERGENT_PATH = /(^|\/)(login|log-in|signin|sign-in|sso|auth|account|error|404|not-?found|home|index(\.\w+)?|default(\.\w+)?|welcome|expired|unavailable|maintenance)(\/|$)/i;

function isRootish(u: string): boolean {
  try {
    const x = new URL(u);
    return (x.pathname === '/' || x.pathname === '') && !x.search;
  } catch {
    return false;
  }
}

export function findDuplicates(bookmarks: readonly FlatBookmark[], signals: ReadonlyMap<string, LinkSignals> = new Map()): DuplicateReport {
  const byId = new Map(bookmarks.map((b) => [b.id, b]));
  const keys = new Map(bookmarks.map((b) => [b.id, urlKeys(b.url)]));
  const uf = new UnionFind();
  const edgeKinds = new Map<string, Set<EvidenceKind>>(); // root → kinds (recomputed later)
  const pairEvidence: Array<[string, string, EvidenceKind]> = [];

  const bucket = (fn: (id: string) => string | undefined) => {
    const m = new Map<string, string[]>();
    for (const b of bookmarks) {
      const k = fn(b.id);
      if (!k) continue;
      (m.get(k) ?? m.set(k, []).get(k)!).push(b.id);
    }
    return m;
  };

  // 1) identical originals
  for (const [, ids] of bucket((id) => byId.get(id)!.url)) {
    if (ids.length < 2) continue;
    for (let i = 1; i < ids.length; i++) {
      uf.union(ids[0]!, ids[i]!);
      pairEvidence.push([ids[0]!, ids[i]!, 'identical']);
    }
  }
  // 2) normalized (only http/https keys differ from originals)
  for (const [, ids] of bucket((id) => {
    const k = keys.get(id)!;
    return k.parsed && (k.scheme === 'http' || k.scheme === 'https') ? k.normalized : undefined;
  })) {
    const distinct = new Set(ids.map((id) => byId.get(id)!.url));
    if (ids.length < 2 || distinct.size < 2) continue;
    for (let i = 1; i < ids.length; i++) {
      if (byId.get(ids[0]!)!.url === byId.get(ids[i]!)!.url) continue;
      uf.union(ids[0]!, ids[i]!);
      pairEvidence.push([ids[0]!, ids[i]!, 'normalized']);
    }
  }
  // 3) tracking variants
  for (const [, ids] of bucket((id) => {
    const k = keys.get(id)!;
    return k.parsed && (k.scheme === 'http' || k.scheme === 'https') ? k.trackingStripped : undefined;
  })) {
    const distinct = new Set(ids.map((id) => keys.get(id)!.normalized));
    if (ids.length < 2 || distinct.size < 2) continue;
    for (let i = 1; i < ids.length; i++) {
      if (keys.get(ids[0]!)!.normalized === keys.get(ids[i]!)!.normalized) continue;
      uf.union(ids[0]!, ids[i]!);
      pairEvidence.push([ids[0]!, ids[i]!, 'tracking']);
    }
  }

  // Build high-confidence groups.
  const groupsByRoot = new Map<string, string[]>();
  for (const b of bookmarks) {
    const r = uf.find(b.id);
    (groupsByRoot.get(r) ?? groupsByRoot.set(r, []).get(r)!).push(b.id);
  }
  for (const [a, , kind] of pairEvidence) {
    const r = uf.find(a);
    (edgeKinds.get(r) ?? edgeKinds.set(r, new Set()).get(r)!).add(kind);
  }
  const unitOf = (id: string) => uf.find(id);
  const unitMembers = (root: string) => groupsByRoot.get(root) ?? [root];

  const byDate = (x: string, y: string) => (byId.get(x)!.dateAdded ?? Infinity) - (byId.get(y)!.dateAdded ?? Infinity) || x.localeCompare(y, 'en', { numeric: true });
  const groups: DuplicateGroup[] = [];
  for (const [root, members] of groupsByRoot) {
    if (members.length < 2) continue;
    members.sort(byDate);
    const kinds = edgeKinds.get(root) ?? new Set<EvidenceKind>();
    const evidence: Evidence[] = [];
    if (kinds.has('identical')) evidence.push({ kind: 'identical', confidence: 'high', detail: 'Identical saved URLs' });
    if (kinds.has('normalized')) evidence.push({ kind: 'normalized', confidence: 'high', detail: 'URLs differ only in case of scheme/host, default port, or empty query/fragment' });
    if (kinds.has('tracking')) {
      const removed = new Set(members.flatMap((m) => keys.get(m)!.removedParams));
      evidence.push({ kind: 'tracking', confidence: 'high', detail: `URLs differ only in tracking parameters (${[...removed].slice(0, 6).join(', ')})` });
    }
    const parents = new Set(members.map((m) => byId.get(m)!.parentId));
    groups.push({ id: `dup-${root}`, members, evidence, key: keys.get(members[0]!)!.trackingStripped, sameFolder: parents.size === 1 });
  }

  // 4/5) Weak evidence → pairwise suggestions between units.
  const convergent: DuplicateReport['convergentDestinations'] = [];
  const suggestions = new Map<string, DuplicateSuggestion>();
  const addSuggestion = (u1: string, u2: string, ev: Evidence) => {
    if (u1 === u2) return;
    const [x, y] = u1 < u2 ? [u1, u2] : [u2, u1];
    const id = `sug-${x}-${y}`;
    let s = suggestions.get(id);
    if (!s) {
      s = { id, a: [...unitMembers(x)].sort(byDate), b: [...unitMembers(y)].sort(byDate), evidence: [], confidence: 'low' };
      suggestions.set(id, s);
    }
    if (!s.evidence.some((e) => e.kind === ev.kind)) s.evidence.push(ev);
    // Two independent weak signals (redirect + canonical) agreeing → medium.
    const strongest = s.evidence.some((e) => e.confidence === 'medium');
    s.confidence = strongest || s.evidence.length >= 2 ? 'medium' : 'low';
  };

  const destUnits = new Map<string, Set<string>>();
  const destSites = new Map<string, Set<string>>();
  const destLogin = new Map<string, boolean>();
  const addDest = (dest: string, id: string, login: boolean | undefined) => {
    (destUnits.get(dest) ?? destUnits.set(dest, new Set()).get(dest)!).add(unitOf(id));
    (destSites.get(dest) ?? destSites.set(dest, new Set()).get(dest)!).add(siteOf(keys.get(id)!.host));
    if (login) destLogin.set(dest, true);
  };
  for (const b of bookmarks) {
    const s = signals.get(b.id);
    if (s?.finalUrl && s.finalUrl !== b.url) addDest(urlKeys(s.finalUrl).trackingStripped, b.id, s.loginOrChallenge);
  }
  // A bookmark whose own URL equals another's redirect destination joins that destination.
  const ownByKey = bucket((id) => keys.get(id)!.trackingStripped);
  for (const [dest, units] of destUnits) {
    const sites = destSites.get(dest)!;
    let reason = '';
    if (destLogin.get(dest)) reason = 'login or challenge page';
    else if (CONVERGENT_PATH.test(safePath(dest))) reason = 'shared login/error/home path';
    else if (isRootish(dest) && units.size > 1) reason = 'site home page';
    else if (units.size > 4) reason = `${units.size} unrelated bookmarks redirect here`;
    else if (sites.size > 2) reason = 'bookmarks from several sites converge here';
    if (reason) {
      convergent.push({ url: dest, count: units.size, reason });
      continue;
    }
    const all = new Set(units);
    for (const id of ownByKey.get(dest) ?? []) all.add(unitOf(id));
    const list = [...all];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        addSuggestion(list[i]!, list[j]!, { kind: 'redirect', confidence: 'medium', detail: 'Observed to arrive at the same final URL' });
      }
    }
  }

  // Canonicals: per-pair only; ignore overbroad (root canonical for deep pages) and cross-site ones unless corroborated.
  const canonUnits = new Map<string, Set<string>>();
  for (const b of bookmarks) {
    const c = signals.get(b.id)?.canonical;
    if (!c) continue;
    const ck = urlKeys(c);
    if (!ck.parsed) continue;
    const ownPathDeep = safePath(b.url).split('/').filter(Boolean).length > 0;
    if (isRootish(c) && ownPathDeep) continue; // overbroad canonical
    if (siteOf(ck.host) !== siteOf(keys.get(b.id)!.host)) continue; // cross-site canonical: advisory only
    (canonUnits.get(ck.trackingStripped) ?? canonUnits.set(ck.trackingStripped, new Set()).get(ck.trackingStripped)!).add(unitOf(b.id));
  }
  for (const [canon, units] of canonUnits) {
    for (const id of ownByKey.get(canon) ?? []) units.add(unitOf(id));
    if (units.size < 2 || units.size > 4) continue; // too many → likely a template-level canonical
    const list = [...units];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        addSuggestion(list[i]!, list[j]!, { kind: 'canonical', confidence: 'low', detail: 'Pages declare the same canonical URL (advisory; may be wrong)' });
      }
    }
  }

  const inGroups = groups.reduce((n, g) => n + g.members.length, 0);
  return {
    groups: groups.sort((a, b) => b.members.length - a.members.length || a.key.localeCompare(b.key)),
    suggestions: [...suggestions.values()].sort((a, b) => (a.confidence === b.confidence ? 0 : a.confidence === 'medium' ? -1 : 1)),
    convergentDestinations: convergent,
    stats: { bookmarks: bookmarks.length, inGroups, removableIfKeepOne: inGroups - groups.length },
  };
}

function safePath(u: string): string {
  try {
    return new URL(u).pathname;
  } catch {
    return '';
  }
}

export type KeepPolicy = 'oldest' | 'newest' | 'shallowest' | 'manual';

/** Pick the bookmark to keep. dateAdded is the stored creation date, which may differ from when it was first saved. */
export function chooseKeeper(members: readonly FlatBookmark[], policy: KeepPolicy, manualId?: string): string {
  if (!members.length) throw new Error('Empty group');
  if (policy === 'manual' && manualId && members.some((m) => m.id === manualId)) return manualId;
  const sorted = [...members];
  if (policy === 'newest') sorted.sort((a, b) => (b.dateAdded ?? -Infinity) - (a.dateAdded ?? -Infinity));
  else if (policy === 'shallowest') sorted.sort((a, b) => a.depth - b.depth || (a.dateAdded ?? Infinity) - (b.dateAdded ?? Infinity));
  else sorted.sort((a, b) => (a.dateAdded ?? Infinity) - (b.dateAdded ?? Infinity));
  // Never pick an unmodifiable bookmark as a removal candidate: prefer keeping it.
  const locked = sorted.find((m) => !m.writable);
  return (locked ?? sorted[0]!).id;
}

/**
 * Default selection for removal: only same-folder duplicates are preselected.
 * Copies in different folders may be intentional and stay unselected.
 */
export function defaultRemovalSelection(group: DuplicateGroup, members: readonly FlatBookmark[], policy: KeepPolicy): string[] {
  if (!group.sameFolder) return [];
  const keep = chooseKeeper(members, policy);
  return members.filter((m) => m.id !== keep && m.writable).map((m) => m.id);
}
