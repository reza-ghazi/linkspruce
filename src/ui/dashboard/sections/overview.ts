/** Overview & Link Health: counts, online-check consent/permissions, scan controls, results table. */
import { HEALTH_LABELS, type HealthStatus } from '../../../core/audit/probe.ts';
import type { HealthRecord } from '../../../core/repo.ts';
import type { FlatBookmark } from '../../../core/tree.ts';
import { auditEligibility } from '../../../core/url.ts';
import { hasBroadHostAccess, repo } from '../../shared/data.ts';
import { append, bidi, confirmDialog, fmtDate, h, plural, progress, toast } from '../../shared/dom.ts';
import { dataTable } from '../../shared/table.ts';
import type { Ctx } from '../dashboard.ts';
import { act, folderSelect, healthBadge, memoGet, metric, relTime, sectionHead } from './common.ts';

interface Filters {
  q: string;
  status: string;
  folder: string;
  page: number;
  selected: Set<string>;
}

function originsIn(bookmarks: FlatBookmark[]): string[] {
  const set = new Set<string>();
  for (const b of bookmarks) {
    if (!auditEligibility(b.url).ok) continue;
    try {
      const u = new URL(b.url);
      set.add(`${u.protocol}//${u.hostname}/*`);
    } catch {
      /* skip */
    }
  }
  return [...set];
}

export async function renderOverview(el: HTMLElement, ctx: Ctx): Promise<void> {
  const f = memoGet<Filters>(ctx.memo, 'overview', () => ({ q: '', status: '', folder: '', page: 0, selected: new Set() }));
  const health = await repo.health.all();
  const broad = await hasBroadHostAccess();
  const { flat } = ctx.tree;
  const counts = new Map<HealthStatus, number>();
  let checked = 0;
  let lastChecked = 0;
  for (const b of flat.bookmarks) {
    const r = health.get(b.id);
    if (!r || r.url !== b.url) continue;
    checked++;
    lastChecked = Math.max(lastChecked, r.checkedAt);
    counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
  }
  const job = ctx.jobs.audit;
  const running = job && (job.status === 'running' || job.status === 'paused');

  const scopeSel = folderSelect(ctx.tree, { value: memoGet(ctx.memo, 'auditScope', () => ''), allLabel: 'Whole library', label: 'Scope for link check', onchange: (v) => ctx.memo.set('auditScope', v) });
  const scopeIds = () => (scopeSel.value ? [scopeSel.value] : []);

  const startScan = async (mode: 'stale' | 'all') => {
    const ok = await confirmDialog({
      title: 'Check links online?',
      body: [
        h('p', null, 'LinkSpruce will send a request to each bookmarked website in the selected scope to see whether it still responds. Websites will see these requests (like a visit without cookies).'),
        h('ul', null, h('li', null, 'At most 5 requests at a time, one per site, spaced out; timeouts and retries are bounded.'), h('li', null, 'No cookies or logins are sent; pages are never rendered or run.'), h('li', null, 'Skipped by default: local/private-network addresses, URLs with embedded credentials, and URLs that look like they contain tokens or perform actions (logout, delete, unsubscribe…). Detection cannot catch every sensitive URL.'), h('li', null, 'Nothing is deleted automatically. A failed check is not proof a link is dead.')),
        h('p', { class: 'muted' }, `Add exclusions (domains or URL prefixes) in Settings. ${mode === 'stale' ? 'Only unchecked, changed or stale results will be checked.' : 'Every bookmark in scope will be rechecked.'}`),
      ],
      confirm: 'Start checking',
    });
    if (!ok) return;
    await act({ type: 'auditStart', mode, folderIds: scopeIds(), ids: [] }, 'Link check started. You can close this tab; it continues in the background.');
    await ctx.refresh();
  };

  const grantBroad = async () => {
    const granted = await chrome.permissions.request({ origins: ['https://*/*', 'http://*/*'] });
    await act({ type: 'permissionsChanged' });
    toast(granted ? 'Access granted. You can revoke it any time in Settings or chrome://extensions.' : 'Access was not granted. Offline features keep working.', granted ? 'success' : 'info');
    await ctx.refresh();
  };
  const grantScoped = async () => {
    const scoped = scopeSel.value ? flat.bookmarks.filter((b) => b.pathIds.includes(scopeSel.value) || b.parentId === scopeSel.value) : flat.bookmarks;
    const origins = originsIn(scoped);
    if (origins.length > 400) {
      toast(`This scope contains ${origins.length} sites; choose a smaller folder or grant access to all sites.`, 'error');
      return;
    }
    const granted = await chrome.permissions.request({ origins });
    await act({ type: 'permissionsChanged' });
    toast(granted ? `Access granted for ${origins.length} site(s).` : 'Access was not granted.');
    await ctx.refresh();
  };

  const permissionPanel = broad
    ? null
    : h(
        'div',
        { class: 'panel' },
        h('h2', null, 'Online link checking needs site access'),
        h('p', null, 'Duplicate detection, organization and backups work offline without any site access. To check whether links still work, Chrome must allow LinkSpruce to contact the bookmarked sites. You choose the scope; you can revoke access later.'),
        h('div', { class: 'btn-row' }, h('button', { class: 'btn btn-primary', onclick: grantBroad }, 'Allow access to all http/https sites'), h('button', { class: 'btn', onclick: grantScoped }, 'Allow only sites in the selected scope')),
      );

  const controls = h(
    'div',
    { class: 'panel', id: 'overview-scan' },
    h('h2', null, 'Link health check'),
    h('div', { class: 'toolbar' }, h('label', { class: 'small' }, 'Scope ', scopeSel)),
    job && running
      ? h(
          'div',
          { class: 'grid' },
          progress(job.completed + job.failed + job.skipped, job.total, 'Link check progress'),
          h('div', { class: 'small muted' }, `${(job.completed + job.failed + job.skipped).toLocaleString()} of ${job.total.toLocaleString()} processed · ${Object.keys(job.retries).length} waiting to retry${job.status === 'paused' ? ` · paused (${job.pausedReason ?? 'user'})` : ''}`),
          h(
            'div',
            { class: 'btn-row' },
            job.status === 'running' ? h('button', { class: 'btn', onclick: () => act({ type: 'jobControl', job: 'audit', action: 'pause' }).then(ctx.refresh) }, 'Pause') : h('button', { class: 'btn btn-primary', onclick: () => act({ type: 'jobControl', job: 'audit', action: 'resume' }).then(ctx.refresh) }, 'Resume'),
            h('button', { class: 'btn', onclick: () => act({ type: 'jobControl', job: 'audit', action: 'cancel' }).then(ctx.refresh) }, 'Cancel'),
          ),
        )
      : h(
          'div',
          { class: 'btn-row' },
          h('button', { class: 'btn btn-primary', onclick: () => startScan('stale') }, 'Start check'),
          h('button', { class: 'btn', onclick: () => startScan('all') }, 'Rescan everything in scope'),
          h('span', { class: 'small muted' }, `Results are reused for ${ctx.settings.audit.freshnessDays} days. Last check: ${relTime(lastChecked || undefined)}.`),
        ),
  );

  // Results table
  const statusSel = h('select', { class: 'input', 'aria-label': 'Filter by status', onchange: (e: Event) => ((f.status = (e.target as HTMLSelectElement).value), (f.page = 0), void ctx.refresh()) }, h('option', { value: '' }, 'All statuses'), h('option', { value: 'unchecked' }, 'Not checked'), ...(Object.keys(HEALTH_LABELS) as HealthStatus[]).map((s) => h('option', { value: s }, HEALTH_LABELS[s])));
  statusSel.value = f.status;
  const search = h('input', { type: 'search', class: 'input grow', placeholder: 'Search title or URL', 'aria-label': 'Search bookmarks', value: f.q, onchange: (e: Event) => ((f.q = (e.target as HTMLInputElement).value), (f.page = 0), void ctx.refresh()) });
  const folderFilter = folderSelect(ctx.tree, { value: f.folder, allLabel: 'All folders', label: 'Filter by folder', onchange: (v) => ((f.folder = v), (f.page = 0), void ctx.refresh()) });
  const q = f.q.trim().toLowerCase();
  const rows = flat.bookmarks.filter((b) => {
    const r = health.get(b.id);
    const valid = r && r.url === b.url ? r : undefined;
    if (f.status === 'unchecked' ? valid : f.status && valid?.status !== f.status) return false;
    if (f.folder && !b.pathIds.includes(f.folder) && b.parentId !== f.folder) return false;
    if (q && !b.title.toLowerCase().includes(q) && !b.url.toLowerCase().includes(q)) return false;
    return true;
  });
  const recOf = (b: FlatBookmark): HealthRecord | undefined => {
    const r = health.get(b.id);
    return r && r.url === b.url ? r : undefined;
  };
  const selectedIds = () => [...f.selected].filter((id) => flat.byId.has(id));
  const retry = async () => {
    const ids = selectedIds();
    if (!ids.length) return toast('Select bookmarks to retry first.');
    await act({ type: 'auditRetry', ids }, `Rechecking ${plural(ids.length, 'bookmark')}.`);
    await ctx.refresh();
  };
  const removeDead = async () => {
    const ids = selectedIds();
    const ok = ids.filter((id) => {
      const b = flat.byId.get(id) as FlatBookmark | undefined;
      const r = b ? recOf(b) : undefined;
      return r?.status === 'not-found' && r.notFoundConfirmedAt;
    });
    if (!ok.length) return toast('Only bookmarks whose "Not found" result was confirmed by a later recheck can be removed. Select some and use "Recheck selected" first.');
    const confirmed = await confirmDialog({
      title: `Remove ${plural(ok.length, 'bookmark')}?`,
      body: [
        h('p', null, `${ok.length} selected bookmark(s) returned "Not found" (404/410) on two checks at least ${ctx.settings.audit.notFoundRecheckMinutes} minutes apart.${ids.length > ok.length ? ` ${ids.length - ok.length} other selected bookmark(s) are not eligible and will be kept.` : ''}`),
        h('p', null, 'A complete backup snapshot is saved first, and you can undo this from Backup & Restore. A page that is "not found" today may come back, and a dead link can still be useful as a reference.'),
      ],
      confirm: 'Remove bookmarks',
      danger: true,
    });
    if (!confirmed) return;
    if (await act({ type: 'removeApply', removeIds: ok, reason: 'dead-links' }, 'Removing… a snapshot was saved first.')) f.selected.clear();
    await ctx.refresh();
  };

  const table = dataTable({
    caption: 'Bookmarks and link health',
    rows,
    id: (b) => b.id,
    pageSize: ctx.settings.ui.pageSize,
    selectable: true,
    selected: f.selected,
    page: f.page,
    onPage: (p) => (f.page = p),
    empty: rows.length === 0 && flat.bookmarks.length === 0 ? 'No bookmarks yet.' : 'No bookmarks match these filters.',
    columns: [
      { label: 'Bookmark', cell: (b) => h('div', null, h('div', { class: 'title-cell' }, bidi(b.title || '(untitled)')), h('div', { class: 'url' }, b.url)) },
      { label: 'Folder', cell: (b) => bidi(b.path.join(' › ') || '—', 'small') },
      {
        label: 'Status',
        cell: (b) => {
          const r = recOf(b);
          return h('div', null, healthBadge(r?.status, !!r?.notFoundConfirmedAt), r?.flags.includes('soft-404-suspected') ? h('div', { class: 'small muted' }, 'Possible soft 404 (uncertain)') : null, r?.skipReason ? h('div', { class: 'small muted' }, `Skipped: ${r.skipReason}`) : null);
        },
      },
      { label: 'HTTP', cls: 'num', cell: (b) => String(recOf(b)?.httpStatus ?? '—') },
      { label: 'Final URL', cell: (b) => { const r = recOf(b); return r?.finalUrl && r.finalUrl !== b.url ? h('span', { class: 'url' }, r.finalUrl) : h('span', { class: 'muted' }, '—'); } },
      { label: 'Checked', cell: (b) => h('span', { class: 'small' }, fmtDate(recOf(b)?.checkedAt)) },
    ],
  });

  const mainMetrics = h(
    'div',
    { class: 'cards' },
    metric(flat.bookmarks.length, 'Bookmarks'),
    metric(flat.folders.length, 'Folders'),
    metric(checked, 'Checked online'),
    metric(counts.get('reachable') ?? 0, 'Reachable'),
    metric((counts.get('redirected') ?? 0), 'Redirected'),
    metric(counts.get('not-found') ?? 0, 'Not found'),
    metric(counts.get('access-restricted') ?? 0, 'Access restricted'),
    metric((counts.get('timeout') ?? 0) + (counts.get('network-error') ?? 0) + (counts.get('server-error') ?? 0) + (counts.get('rate-limited') ?? 0), 'Temporary problems'),
  );

  append(
    el,
    sectionHead('Overview & Link Health', 'A snapshot of your library and the results of online link checks. Timeouts, blocked requests and errors are reported as uncertain, never as proof a link is dead.'),
    mainMetrics,
    permissionPanel ?? h('span'),
    controls,
    h('div', { class: 'panel' }, h('h2', null, 'Bookmarks'), h('div', { class: 'toolbar' }, search, statusSel, folderFilter, h('button', { class: 'btn', onclick: retry }, 'Recheck selected'), h('button', { class: 'btn', onclick: removeDead }, 'Remove selected not-found…')), table),
  );
}
