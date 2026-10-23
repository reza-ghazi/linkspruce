/** Helpers shared by dashboard sections. */
import { HEALTH_LABELS, type HealthStatus } from '../../../core/audit/probe.ts';
import type { Band } from '../../../core/classify/classifier.ts';
import type { FlatFolder } from '../../../core/tree.ts';
import { send, type Msg } from '../../../shared/messages.ts';
import { h, toast } from '../../shared/dom.ts';
import type { TreeData } from '../../shared/data.ts';

const HEALTH_CLASS: Record<HealthStatus, string> = {
  reachable: 'badge-ok',
  redirected: 'badge-info',
  'not-found': 'badge-bad',
  'access-restricted': 'badge-warn',
  'rate-limited': 'badge-warn',
  'server-error': 'badge-warn',
  'network-error': 'badge-warn',
  timeout: 'badge-warn',
  inconclusive: '',
  skipped: '',
  unsupported: '',
};

export function healthBadge(status: HealthStatus | undefined, confirmed = false): HTMLElement {
  if (!status) return h('span', { class: 'badge' }, 'Not checked');
  const label = status === 'not-found' ? (confirmed ? 'Not found (rechecked)' : 'Not found (recheck pending)') : HEALTH_LABELS[status];
  return h('span', { class: `badge ${HEALTH_CLASS[status]}` }, label);
}

export function bandBadge(band: Band | null | undefined, review?: string): HTMLElement {
  if (review) return h('span', { class: 'badge badge-warn', title: review }, 'Needs review');
  if (!band) return h('span', { class: 'badge' }, '—');
  return h('span', { class: `badge ${band === 'high' ? 'badge-ok' : band === 'medium' ? 'badge-info' : 'badge-warn'}` }, band === 'high' ? 'High' : band === 'medium' ? 'Medium' : 'Low');
}

export function folderLabel(f: FlatFolder): string {
  return [...f.path, f.title].join(' › ') || '(root)';
}

/** Folder <select>, writable-only optional. Value "" = whole library. */
export function folderSelect(tree: TreeData, opts: { value?: string | null; writableOnly?: boolean; allLabel?: string; label: string; id?: string; onchange?: (v: string) => void }): HTMLSelectElement {
  const sel = h('select', { class: 'input', 'aria-label': opts.label, id: opts.id, onchange: (e: Event) => opts.onchange?.((e.target as HTMLSelectElement).value) });
  if (opts.allLabel) sel.appendChild(h('option', { value: '' }, opts.allLabel));
  const perm = (tree.root.children ?? []).map((c) => ({ id: c.id, title: c.title }));
  for (const p of perm) {
    const f = tree.flat.byId.get(p.id) as FlatFolder | undefined;
    if (opts.writableOnly && f && !f.writable) continue;
    sel.appendChild(h('option', { value: p.id }, p.title));
  }
  for (const f of tree.flat.folders) {
    if (perm.some((p) => p.id === f.id)) continue;
    if (opts.writableOnly && !f.writable) continue;
    sel.appendChild(h('option', { value: f.id }, folderLabel(f)));
  }
  sel.value = opts.value ?? '';
  return sel;
}

/** Send a message, toast errors, and return the result (undefined on error). */
export async function act<T = unknown>(msg: Msg, success?: string): Promise<T | undefined> {
  try {
    const r = await send<T>(msg);
    if (success) toast(success, 'success');
    return r;
  } catch (e) {
    toast((e as Error).message, 'error');
    return undefined;
  }
}

export function sectionHead(title: string, intro: string, ...actions: Array<Node | null>): HTMLElement {
  return h('div', { class: 'section-head' }, h('div', null, h('h1', null, title), h('p', null, intro)), h('div', { class: 'btn-row' }, ...actions));
}

export function metric(value: string | number, label: string): HTMLElement {
  return h('div', { class: 'metric' }, h('b', null, typeof value === 'number' ? value.toLocaleString() : value), h('span', null, label));
}

export function memoGet<T>(memo: Map<string, unknown>, key: string, init: () => T): T {
  if (!memo.has(key)) memo.set(key, init());
  return memo.get(key) as T;
}

export function relTime(ms: number | undefined): string {
  if (!ms) return '—';
  const d = Date.now() - ms;
  if (d < 60_000) return 'just now';
  if (d < 3600_000) return `${Math.round(d / 60_000)} min ago`;
  if (d < 86_400_000) return `${Math.round(d / 3600_000)} h ago`;
  return `${Math.round(d / 86_400_000)} days ago`;
}
