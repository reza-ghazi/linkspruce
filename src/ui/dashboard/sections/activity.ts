/** Auto-filing activity: recent automatic actions (Undo / Change category), held bursts, items left for review. */
import { activeCategories, pathLabel } from '../../../core/taxonomy/taxonomy.ts';
import { activity, autofileQueue } from '../../shared/data.ts';
import { append, bidi, confirmDialog, fmtDate, h, plural } from '../../shared/dom.ts';
import { dataTable } from '../../shared/table.ts';
import type { Ctx } from '../dashboard.ts';
import { act, bandBadge, memoGet, sectionHead } from './common.ts';

const KIND_LABEL: Record<string, [string, string]> = {
  filed: ['Filed', 'badge-ok'],
  review: ['Needs review', 'badge-warn'],
  skipped: ['Skipped', ''],
  error: ['Error', 'badge-bad'],
  undone: ['Undone', 'badge-info'],
  held: ['Held for review', 'badge-warn'],
  'moved-by-user': ['Kept your choice', 'badge-info'],
};

export async function renderActivity(el: HTMLElement, ctx: Ctx): Promise<void> {
  const st = memoGet(ctx.memo, 'activity', () => ({ page: 0, heldSel: new Set<string>() }));
  const [acts, queue] = await Promise.all([activity(), autofileQueue()]);
  const t = ctx.taxonomy;
  const s = ctx.settings;

  const change = async (bookmarkId: string, title: string) => {
    if (!t) return;
    const sel = h('select', { class: 'input', 'aria-label': 'New category' }, ...activeCategories(t).map((c) => h('option', { value: c.id }, pathLabel(t, c.id))));
    const ok = await confirmDialog({ title: 'Change category', body: [h('p', null, bidi(title)), sel, h('p', { class: 'small muted' }, 'LinkSpruce will remember this choice and not move this bookmark again automatically.')], confirm: 'Move' });
    if (!ok) return;
    await act({ type: 'autofileChange', bookmarkId, categoryId: sel.value }, 'Moved.');
    await ctx.refresh();
  };

  const held = Object.values(queue).filter((q) => q.status === 'held');
  const review = Object.values(queue).filter((q) => q.status === 'review' || q.status === 'error');
  const pending = Object.values(queue).filter((q) => q.status === 'settling' || q.status === 'retry');

  append(
    el,
    sectionHead(
      'Auto-filing Activity',
      'What LinkSpruce did with newly saved bookmarks. Every automatic move can be undone individually; undone or manually moved bookmarks are never filed again automatically.',
      s.autoFile.enabled ? h('button', { class: 'btn', onclick: () => act({ type: 'autofilePause', paused: !s.autoFile.paused }).then(ctx.refresh) }, s.autoFile.paused ? 'Resume auto-filing' : 'Pause auto-filing') : h('a', { class: 'btn btn-primary', href: '#settings-autofile' }, 'Set up auto-filing'),
    ),
    !s.autoFile.enabled ? h('div', { class: 'notice' }, 'Auto-filing is off. When you turn it on, newly saved bookmarks are classified and moved into your categories automatically; ambiguous ones stay where you saved them.') : null,
    pending.length ? h('div', { class: 'notice' }, `${plural(pending.length, 'bookmark')} waiting a few seconds before filing (so you can finish editing the title or folder).`) : null,
    held.length
      ? h(
          'div',
          { class: 'panel' },
          h('h2', null, 'Held for bulk review', h('span', { class: 'badge badge-warn' }, held.length.toLocaleString())),
          h('p', { class: 'muted' }, 'These arrived in a burst or during an import, so they were not filed one by one. File them now or leave them where they are.'),
          h('div', { class: 'toolbar' }, h('button', { class: 'btn btn-primary', onclick: () => act({ type: 'autofileRelease', ids: [...(st.heldSel.size ? st.heldSel : new Set(held.map((x) => x.id)))], action: 'file' }, 'Queued for filing.').then(ctx.refresh) }, st.heldSel.size ? 'File selected' : 'File all'), h('button', { class: 'btn', onclick: () => act({ type: 'autofileRelease', ids: [...(st.heldSel.size ? st.heldSel : new Set(held.map((x) => x.id)))], action: 'dismiss' }).then(ctx.refresh) }, st.heldSel.size ? 'Leave selected' : 'Leave all where they are')),
          dataTable({ caption: 'Held bookmarks', rows: held, id: (q) => q.id, pageSize: 50, selectable: true, selected: st.heldSel, empty: '', columns: [{ label: 'Bookmark', cell: (q) => h('div', null, h('div', { class: 'title-cell' }, bidi(q.title)), h('div', { class: 'url' }, q.url)) }, { label: 'Saved', cell: (q) => h('span', { class: 'small' }, fmtDate(q.firstSeen)) }] }),
        )
      : null,
    h(
      'div',
      { class: 'panel', id: 'activity-recent' },
      h('h2', null, 'Recent automatic actions'),
      dataTable({
        caption: 'Recent automatic actions',
        rows: acts.filter((a) => a.bookmarkId || a.message),
        id: (a) => a.id,
        pageSize: 50,
        page: st.page,
        onPage: (p) => (st.page = p),
        empty: 'No automatic actions yet.',
        columns: [
          { label: 'When', cell: (a) => h('span', { class: 'small' }, fmtDate(a.at)) },
          { label: 'What', cell: (a) => { const [label, cls] = KIND_LABEL[a.kind] ?? [a.kind, '']; return h('span', { class: `badge ${cls}` }, label); } },
          {
            label: 'Bookmark',
            cell: (a) =>
              h(
                'div',
                null,
                a.title ? h('div', { class: 'title-cell' }, bidi(a.title)) : null,
                a.toPath ? h('div', { class: 'small' }, `Saved to ${a.toPath.slice(1).join(' › ')}`) : null,
                a.fromPath ? h('div', { class: 'small muted' }, 'from ', bidi(a.fromPath.join(' › '))) : null,
                a.createdCategories?.length ? h('div', { class: 'small' }, h('span', { class: 'badge badge-info' }, 'New category'), ' ', a.createdCategories.join(', ')) : null,
                a.message ? h('div', { class: 'small muted' }, a.message) : null,
              ),
          },
          { label: 'Why', cell: (a) => h('div', null, a.band !== undefined ? bandBadge(a.band) : null, a.provider ? h('span', { class: 'small muted' }, ` ${a.provider}`) : null, a.rationale ? h('div', { class: 'small muted' }, bidi(a.rationale)) : null) },
          {
            label: 'Actions',
            cell: (a) =>
              a.kind === 'filed' && !a.undone && a.batchId
                ? h('div', { class: 'btn-row' }, h('button', { class: 'btn btn-small', onclick: () => act<{ message: string }>({ type: 'autofileUndo', activityId: a.id }).then(ctx.refresh) }, 'Undo'), t ? h('button', { class: 'btn btn-small', onclick: () => change(a.bookmarkId, a.title) }, 'Change category') : null)
                : a.undone
                  ? h('span', { class: 'small muted' }, 'Undone')
                  : h('span'),
          },
        ],
      }),
    ),
    review.length
      ? h(
          'div',
          { class: 'panel' },
          h('h2', null, 'Left where you saved them', h('span', { class: 'badge' }, review.length.toLocaleString())),
          h('p', { class: 'muted' }, 'Not confident enough to file automatically, or something went wrong. Pick a category to move them, or leave them.'),
          dataTable({
            caption: 'New bookmarks left for review',
            rows: review,
            id: (q) => q.id,
            pageSize: 50,
            empty: '',
            columns: [
              { label: 'Bookmark', cell: (q) => h('div', null, h('div', { class: 'title-cell' }, bidi(q.title)), h('div', { class: 'url' }, q.url)) },
              { label: 'Reason', cell: (q) => h('span', { class: 'small' }, q.reason ?? '') },
              { label: '', cell: (q) => (t ? h('button', { class: 'btn btn-small', onclick: () => change(q.id, q.title) }, 'Choose category') : h('span')) },
            ],
          }),
        )
      : null,
  );
}
