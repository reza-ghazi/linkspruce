/** Duplicates Review: tiered evidence, keep policy, explicit removal with preview + snapshot. */
import { chooseKeeper, defaultRemovalSelection, findDuplicates, type DuplicateGroup, type DuplicateSuggestion, type KeepPolicy, type LinkSignals } from '../../../core/duplicates.ts';
import type { FlatBookmark } from '../../../core/tree.ts';
import { repo } from '../../shared/data.ts';
import { append, bidi, confirmDialog, fmtDay, h, plural, toast } from '../../shared/dom.ts';
import type { Ctx } from '../dashboard.ts';
import { act, memoGet, metric, sectionHead } from './common.ts';

interface DupState {
  policy: KeepPolicy;
  /** group id → selected-for-removal ids (initialized lazily from defaults). */
  remove: Map<string, Set<string>>;
  keepManual: Map<string, string>;
  page: number;
  showSuggestions: boolean;
}

const PAGE = 40;

const EVIDENCE_LABEL: Record<string, string> = {
  identical: 'Identical URL',
  normalized: 'Equivalent URL',
  tracking: 'Tracking parameters only',
  redirect: 'Same redirect destination',
  canonical: 'Same declared canonical',
};

export async function renderDuplicates(el: HTMLElement, ctx: Ctx): Promise<void> {
  const st = memoGet<DupState>(ctx.memo, 'dups', () => ({ policy: ctx.settings.keepPolicy, remove: new Map(), keepManual: new Map(), page: 0, showSuggestions: false }));
  const health = await repo.health.all();
  const { flat } = ctx.tree;
  const signals = new Map<string, LinkSignals>();
  for (const b of flat.bookmarks) {
    const r = health.get(b.id);
    if (!r || r.url !== b.url) continue;
    signals.set(b.id, { finalUrl: r.finalUrl, redirected: r.redirected, canonical: r.meta?.canonical, loginOrChallenge: r.flags.includes('login-page') || r.flags.includes('bot-challenge') });
  }
  const report = findDuplicates(flat.bookmarks, signals);
  const byId = (id: string) => flat.byId.get(id) as FlatBookmark;

  const selectionFor = (g: DuplicateGroup): Set<string> => {
    let s = st.remove.get(g.id);
    if (!s) {
      s = new Set(defaultRemovalSelection(g, g.members.map(byId), st.policy));
      st.remove.set(g.id, s);
    }
    return s;
  };
  const keeperFor = (g: DuplicateGroup): string => chooseKeeper(g.members.map(byId), st.keepManual.has(g.id) ? 'manual' : st.policy, st.keepManual.get(g.id));

  const policySel = h(
    'select',
    {
      class: 'input',
      'aria-label': 'Which copy to keep',
      onchange: (e: Event) => {
        st.policy = (e.target as HTMLSelectElement).value as KeepPolicy;
        st.remove.clear();
        st.keepManual.clear();
        void ctx.refresh();
      },
    },
    h('option', { value: 'oldest' }, 'Keep the oldest copy'),
    h('option', { value: 'newest' }, 'Keep the newest copy'),
    h('option', { value: 'shallowest' }, 'Keep the copy in the shallowest folder'),
  );
  policySel.value = st.policy === 'manual' ? 'oldest' : st.policy;

  const totalSelected = () => [...st.remove.values()].reduce((n, s) => n + s.size, 0);

  const memberRow = (g: DuplicateGroup, id: string, selected: Set<string>) => {
    const b = byId(id);
    const keeper = keeperFor(g) === id;
    const cb = h('input', {
      type: 'checkbox',
      'aria-label': `Remove “${b.title}”`,
      checked: selected.has(id),
      disabled: keeper || !b.writable,
      onchange: (e: Event) => {
        if ((e.target as HTMLInputElement).checked) selected.add(id);
        else selected.delete(id);
        updateBar();
      },
    });
    return h(
      'div',
      { class: 'member' },
      h('div', null, cb),
      h('div', null, h('div', { class: 'title-cell' }, bidi(b.title || '(untitled)')), h('div', { class: 'url' }, b.url), h('div', { class: 'small muted' }, bidi(b.path.join(' › ') || '(top level)'), ` · added ${fmtDay(b.dateAdded)}`)),
      h('div', { class: 'btn-row' }, keeper ? h('span', { class: 'badge badge-ok' }, 'Keep') : h('button', { class: 'btn btn-small', onclick: () => (st.keepManual.set(g.id, id), selected.delete(id), void ctx.refresh()) }, 'Keep this one'), !b.writable ? h('span', { class: 'badge' }, 'Managed') : null),
    );
  };

  const groupCard = (g: DuplicateGroup) => {
    const sel = selectionFor(g);
    return h(
      'section',
      { class: 'group', 'aria-label': `Duplicate group of ${g.members.length}` },
      h('div', { class: 'group-head' }, h('b', null, plural(g.members.length, 'copy', 'copies')), ...g.evidence.map((e) => h('span', { class: 'badge badge-brand', title: e.detail }, EVIDENCE_LABEL[e.kind] ?? e.kind)), g.sameFolder ? h('span', { class: 'badge' }, 'Same folder') : h('span', { class: 'badge badge-info', title: 'Copies in different folders may be intentional; none are preselected.' }, 'Different folders')),
      h('div', { class: 'group-body' }, ...g.members.map((id) => memberRow(g, id, sel))),
    );
  };

  const suggestionCard = (s: DuplicateSuggestion) =>
    h(
      'section',
      { class: 'group' },
      h('div', { class: 'group-head' }, h('span', { class: `badge ${s.confidence === 'medium' ? 'badge-info' : ''}` }, s.confidence === 'medium' ? 'Possible duplicate' : 'Weak suggestion'), ...s.evidence.map((e) => h('span', { class: 'badge', title: e.detail }, EVIDENCE_LABEL[e.kind] ?? e.kind))),
      h(
        'div',
        { class: 'group-body' },
        ...[...s.a, ...s.b].map((id) => {
          const b = byId(id);
          return h('div', { class: 'member' }, h('span'), h('div', null, h('div', { class: 'title-cell' }, bidi(b.title)), h('div', { class: 'url' }, b.url), h('div', { class: 'small muted' }, bidi(b.path.join(' › ')))), h('span'));
        }),
        h('p', { class: 'small muted' }, 'Weaker evidence is never removed in bulk. If these really are the same page, delete the copy you don’t need from Chrome’s bookmark manager, or bookmark the final URL.'),
      ),
    );

  const pages = Math.max(1, Math.ceil(report.groups.length / PAGE));
  st.page = Math.min(st.page, pages - 1);
  const visible = report.groups.slice(st.page * PAGE, (st.page + 1) * PAGE);
  const bar = h('div', { class: 'small' });
  const updateBar = () => {
    bar.textContent = `${totalSelected().toLocaleString()} selected for removal`;
  };

  const apply = async () => {
    // Make sure every group has been initialised so defaults on unseen pages count too.
    for (const g of report.groups) selectionFor(g);
    const ids = [...new Set([...st.remove.values()].flatMap((s) => [...s]))].filter((id) => flat.byId.has(id));
    if (!ids.length) return toast('Nothing selected for removal.');
    const ok = await confirmDialog({
      title: `Remove ${plural(ids.length, 'duplicate bookmark')}?`,
      body: [
        h('p', null, `One copy in every group is kept. ${ids.length} selected bookmark(s) will be removed from Chrome.`),
        h('p', null, 'Before anything changes, LinkSpruce saves a complete snapshot of your bookmarks and records every step, so you can undo this from Backup & Restore.'),
        h('p', { class: 'muted small' }, 'Dates shown are the stored bookmark creation dates; after imports or sync they may not reflect when you first saved a page.'),
      ],
      confirm: 'Remove duplicates',
      danger: true,
    });
    if (!ok) return;
    const r = await act({ type: 'removeApply', removeIds: ids, reason: 'duplicates' }, 'Removing duplicates… a snapshot was saved first.');
    if (r) st.remove.clear();
    await ctx.refresh();
  };

  // Initialise default selections for every group before showing the count.
  for (const g of report.groups) selectionFor(g);
  updateBar();
  append(
    el,
    sectionHead('Duplicates Review', 'Potential duplicates grouped by evidence. Saved URLs are compared after conservative normalization; nothing is changed until you review and confirm.', policySel),
    h('div', { class: 'cards' }, metric(report.groups.length, 'Duplicate groups (high confidence)'), metric(report.stats.removableIfKeepOne, 'Extra copies'), metric(report.suggestions.length, 'Weaker suggestions'), metric(report.convergentDestinations.length, 'Shared destinations not merged')),
    h(
      'div',
      { class: 'notice' },
      'High-confidence groups need identical URLs, URLs that differ only in case/default port/empty query, or URLs that differ only in documented tracking parameters (utm_*, fbclid, gclid, …). ',
      'Different protocols (http/https), www vs non-www, trailing slashes, fragments and other query parameters are kept distinct. ',
      'Copies in different folders are not preselected because they may be intentional.',
    ),
    h('div', { class: 'toolbar' }, bar, h('button', { class: 'btn btn-primary', onclick: apply, disabled: !report.groups.length }, 'Review and remove selected…')),
    ...(visible.length ? visible.map(groupCard) : [h('div', { class: 'empty panel' }, 'No high-confidence duplicates found.')]),
    pages > 1 ? h('div', { class: 'pager' }, h('button', { class: 'btn btn-small', disabled: st.page === 0, onclick: () => (st.page--, void ctx.refresh()) }, '‹ Prev'), h('span', { class: 'small' }, `Page ${st.page + 1} / ${pages}`), h('button', { class: 'btn btn-small', disabled: st.page >= pages - 1, onclick: () => (st.page++, void ctx.refresh()) }, 'Next ›')) : null,
    h(
      'div',
      { class: 'panel' },
      h('h2', null, 'Weaker suggestions'),
      h('p', { class: 'muted' }, 'Based on observed redirect destinations or declared canonical URLs from link checks. These can be wrong (shared login pages, overbroad canonicals), so they are shown separately and never merged automatically.'),
      st.showSuggestions || report.suggestions.length <= 10
        ? h('div', null, ...(report.suggestions.length ? report.suggestions.slice(0, 200).map(suggestionCard) : [h('p', { class: 'muted' }, 'None. Run an online link check to gather redirect and canonical evidence.')]))
        : h('button', { class: 'btn', onclick: () => ((st.showSuggestions = true), void ctx.refresh()) }, `Show ${report.suggestions.length} suggestions`),
      report.convergentDestinations.length
        ? h('details', null, h('summary', null, `${report.convergentDestinations.length} shared destinations were not treated as duplicates`), h('ul', null, ...report.convergentDestinations.slice(0, 100).map((c) => h('li', null, h('span', { class: 'url' }, c.url), ` — ${c.count} bookmarks; ${c.reason}`))))
        : null,
    ),
  );
}
