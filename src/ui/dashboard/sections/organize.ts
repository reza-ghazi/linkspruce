/** Organization Preview: taxonomy discovery/editing, categorization, Needs Review, move preview and apply. */
import type { Availability, ProviderId } from '../../../core/ai/types.ts';
import { RulesClassifier, type Assignment } from '../../../core/classify/classifier.ts';
import { resolveAssignment } from '../../../core/classify/precedence.ts';
import { analyseStructure, consistencyPass, type FolderInfo } from '../../../core/discovery/discovery.ts';
import type { OrganizePlan } from '../../../core/plan.ts';
import { activeCategories, displayName, pathLabel, taxonomyStats, type Category, type Taxonomy, type TaxonomyEdit, type TaxonomyMode } from '../../../core/taxonomy/taxonomy.ts';
import type { FlatBookmark } from '../../../core/tree.ts';
import { send } from '../../../shared/messages.ts';
import { repo } from '../../shared/data.ts';
import { append, bidi, confirmDialog, h, mount, plural, progress, promptDialog, toast } from '../../shared/dom.ts';
import { dataTable } from '../../shared/table.ts';
import type { Ctx } from '../dashboard.ts';
import { availabilityText, confirmEstimate, downloadOnDeviceModel, ensureCloudReady, PROVIDER_LABEL } from './ai-consent.ts';
import { act, bandBadge, folderSelect, memoGet, metric, sectionHead } from './common.ts';
import type { RunEstimate, Budget } from '../../../core/ai/budget.ts';

interface OrgState {
  provider: ProviderId;
  mode: TaxonomyMode;
  scope: string;
  reviewPage: number;
  reviewSel: Set<string>;
  movesPage: number;
  userText: string;
}

const MODES: Record<TaxonomyMode, string> = {
  discover: 'Discover a new structure (recommended)',
  improve: 'Improve my existing folders',
  user: 'Use my own taxonomy',
};

async function startWithProvider(ctx: Ctx, provider: ProviderId, task: 'discover' | 'classify', scope: 'uncertain' | 'all', folderIds: string[]): Promise<boolean> {
  if (provider === 'gemini') {
    if (!(await ensureCloudReady(ctx.settings))) return false;
    const est = await act<RunEstimate & { items: number; budget: Budget }>({ type: 'estimate', task, scope, folderIds });
    if (!est || !(await confirmEstimate(task, est))) return false;
  }
  return true;
}

function categoryOptions(t: Taxonomy, sel: HTMLSelectElement, includeKeep = true): HTMLSelectElement {
  sel.appendChild(h('option', { value: '' }, 'Choose category…'));
  if (includeKeep) sel.appendChild(h('option', { value: '__keep' }, 'Keep where it is'));
  for (const c of activeCategories(t)) sel.appendChild(h('option', { value: c.id }, pathLabel(t, c.id)));
  return sel;
}

function taxonomyTree(t: Taxonomy, target: 'draft' | 'current', counts: Map<string, number>, refresh: () => Promise<void>, editable: boolean): HTMLElement {
  const edit = async (e: TaxonomyEdit) => {
    if (target === 'current') {
      const ok = await confirmDialog({ title: 'Edit the approved taxonomy?', body: [h('p', null, 'This creates a new taxonomy version. Renames and pins keep existing categorizations; merges, splits, moves and rejections mark affected categorizations as stale, and any unapplied preview is discarded.')], confirm: 'Continue' });
      if (!ok) return;
    }
    if (await act({ type: 'taxonomyEdit', target, edit: e })) await refresh();
  };
  const all = t.categories;
  const pick = async (title: string, exclude: string): Promise<string | null | undefined> => {
    const sel = h('select', { class: 'input', 'aria-label': title }, h('option', { value: '__top' }, '(Top level)'), ...all.filter((c) => c.id !== exclude && c.status === 'active').map((c) => h('option', { value: c.id }, pathLabel(t, c.id))));
    const ok = await confirmDialog({ title, body: [sel], confirm: 'OK' });
    if (!ok) return undefined;
    return sel.value === '__top' ? null : sel.value;
  };
  const node = (c: Category): HTMLElement => {
    const kids = all.filter((x) => x.parentId === c.id);
    const n = counts.get(c.id);
    const inactive = c.status !== 'active';
    return h(
      'li',
      null,
      h(
        'div',
        { class: 'tree-row' },
        h('span', { class: 'name', style: inactive ? 'text-decoration:line-through;opacity:.6' : undefined }, displayName(t, c)),
        n !== undefined ? h('span', { class: 'badge' }, n.toLocaleString()) : c.estimatedCount !== undefined ? h('span', { class: 'badge', title: c.estimate ? 'Estimated from a sample' : 'Offline rule count' }, `${c.estimate ? '≈' : ''}${c.estimatedCount.toLocaleString()}`) : null,
        c.pinned ? h('span', { class: 'badge badge-brand' }, 'Pinned') : null,
        c.origin === 'auto-created' ? h('span', { class: 'badge badge-info' }, 'Auto-created') : null,
        inactive ? h('span', { class: 'badge badge-warn' }, c.status === 'rejected' ? 'Rejected' : 'Excluded') : null,
        editable
          ? h(
              'span',
              { class: 'tree-actions' },
              h('button', { class: 'btn btn-small', onclick: async () => { const v = await promptDialog({ title: 'Rename category', label: 'Name', value: c.name }); if (v) await edit({ op: 'rename', id: c.id, name: v }); } }, 'Rename'),
              h('button', { class: 'btn btn-small', onclick: async () => { const v = await promptDialog({ title: `Add subcategory to “${c.name}”`, label: 'Name' }); if (v) await edit({ op: 'add', input: { name: v, parentId: c.id, origin: 'user' } }); } }, 'Add sub'),
              h('button', { class: 'btn btn-small', onclick: async () => { const v = await pick(`Merge “${c.name}” into…`, c.id); if (v) await edit({ op: 'merge', sourceIds: [c.id], targetId: v }); } }, 'Merge'),
              h('button', { class: 'btn btn-small', onclick: async () => { const raw = await promptDialog({ title: `Split “${c.name}”`, label: 'New subcategory names, comma-separated' }); if (raw) await edit({ op: 'split', id: c.id, children: raw.split(',').map((x) => x.trim()).filter(Boolean).map((name) => ({ name, parentId: c.id })) }); } }, 'Split'),
              h('button', { class: 'btn btn-small', onclick: async () => { const v = await pick(`Move “${c.name}” under…`, c.id); if (v !== undefined) await edit({ op: 'reparent', id: c.id, parentId: v }); } }, 'Move'),
              h('button', { class: 'btn btn-small', onclick: () => edit({ op: 'pin', id: c.id, pinned: !c.pinned }) }, c.pinned ? 'Unpin' : 'Pin'),
              inactive ? h('button', { class: 'btn btn-small', onclick: () => edit({ op: 'restore', id: c.id }) }, 'Restore') : h('button', { class: 'btn btn-small', onclick: () => edit({ op: 'reject', id: c.id }) }, 'Reject'),
              !inactive ? h('button', { class: 'btn btn-small', title: 'Exclude this branch from organization', onclick: () => edit({ op: 'exclude', id: c.id }) }, 'Exclude') : null,
            )
          : null,
        c.definition ? h('div', { class: 'def' }, c.definition) : null,
      ),
      kids.length ? h('ul', { class: 'tree' }, ...kids.map(node)) : null,
    );
  };
  return h('ul', { class: 'tree' }, ...all.filter((c) => c.parentId === null).map(node));
}

export async function renderOrganize(el: HTMLElement, ctx: Ctx): Promise<void> {
  const st = memoGet<OrgState>(ctx.memo, 'org', () => ({ provider: ctx.settings.ai.provider, mode: ctx.settings.taxonomyMode, scope: '', reviewPage: 0, reviewSel: new Set(), movesPage: 0, userText: '' }));
  const [draft, plan, avail] = await Promise.all([repo.draftTaxonomy(), repo.plan(), send<Record<'chrome-ai' | 'gemini', Availability>>({ type: 'aiAvailability' }).catch(() => undefined)]);
  const t = ctx.taxonomy;
  const { flat } = ctx.tree;
  const folderIds = st.scope ? [st.scope] : [];

  // ── Provider + mode controls
  const providerSel = h('select', { class: 'input', 'aria-label': 'AI provider', onchange: (e: Event) => ((st.provider = (e.target as HTMLSelectElement).value as ProviderId), void ctx.refresh()) }, ...(['auto', 'rules', 'chrome-ai', 'gemini'] as ProviderId[]).map((p) => h('option', { value: p }, `${PROVIDER_LABEL[p]}${p === 'chrome-ai' || p === 'gemini' ? ` — ${availabilityText(avail?.[p])}` : ''}`)));
  providerSel.value = st.provider;
  const modeSel = h('select', { class: 'input', 'aria-label': 'Organizing mode', onchange: (e: Event) => ((st.mode = (e.target as HTMLSelectElement).value as TaxonomyMode), void ctx.refresh()) }, ...(Object.keys(MODES) as TaxonomyMode[]).map((m) => h('option', { value: m }, MODES[m])));
  modeSel.value = st.mode;
  const granSel = h('select', { class: 'input', 'aria-label': 'Granularity', onchange: (e: Event) => act({ type: 'updateSettings', patch: { granularity: (e.target as HTMLSelectElement).value } }).then(ctx.refresh) }, h('option', { value: 'compact' }, 'Compact (6–10 top-level, 2 levels)'), h('option', { value: 'balanced' }, 'Balanced (10–16 top-level, up to 4 levels)'), h('option', { value: 'detailed' }, 'Detailed (more, deeper categories)'));
  granSel.value = ctx.settings.granularity;
  const langSel = h('select', { class: 'input', 'aria-label': 'Category label language', onchange: (e: Event) => act({ type: 'updateSettings', patch: { labelLanguage: (e.target as HTMLSelectElement).value } }).then(ctx.refresh) }, h('option', { value: 'en' }, 'English labels'), h('option', { value: 'fa' }, 'Persian labels (فارسی)'), h('option', { value: 'bilingual' }, 'Bilingual labels'));
  langSel.value = ctx.settings.labelLanguage;
  const scopeSel = folderSelect(ctx.tree, { value: st.scope, allLabel: 'Whole library', label: 'Scope', onchange: (v) => ((st.scope = v), void ctx.refresh()) });

  const downloadBtn = avail?.['chrome-ai']?.state === 'downloadable' && (st.provider === 'chrome-ai' || st.provider === 'auto')
    ? h('button', { class: 'btn', onclick: async (e: Event) => { const b = e.target as HTMLButtonElement; b.disabled = true; await downloadOnDeviceModel((f) => (b.textContent = `Downloading ${Math.round(f * 100)}%`)); await ctx.refresh(); } }, 'Download on-device model')
    : null;
  const autoNote = st.provider === 'auto' ? h('p', { class: 'small muted' }, avail?.['chrome-ai']?.state === 'available' ? 'Using free on-device AI (Chrome built-in). Nothing leaves your computer.' : `Free on-device AI is not ready (${availabilityText(avail?.['chrome-ai'])}); offline rules will be used.`) : null;

  const discover = async () => {
    if (st.mode === 'improve') {
      await act({ type: 'taxonomyFromFolders' }, 'Draft built from your existing folders.');
      return ctx.refresh();
    }
    if (st.mode === 'user') {
      if (!st.userText.trim()) return toast('Enter your categories first, one per line (indent subcategories).', 'error');
      await act({ type: 'taxonomyParse', text: st.userText }, 'Draft created from your taxonomy.');
      return ctx.refresh();
    }
    if (!(await startWithProvider(ctx, st.provider, 'discover', 'all', folderIds))) return;
    const r = await act<{ draft?: Taxonomy }>({ type: 'discoverStart', provider: st.provider, folderIds });
    if (r?.draft) toast('Offline draft ready. Review and edit it below.', 'success');
    else if (r) toast('Discovery started. It runs in the background and resumes after interruptions.', 'success');
    await ctx.refresh();
  };

  const dj = ctx.jobs.discover;
  const discoveryProgress = dj && (dj.status === 'running' || dj.status === 'paused' || (dj.status === 'completed' && !(dj.options as { synthesized?: boolean }).synthesized))
    ? h('div', { class: 'grid' }, progress(dj.completed + dj.failed + dj.skipped, dj.total, 'Discovery progress'), h('div', { class: 'small muted' }, dj.status === 'completed' ? 'Building the hierarchy…' : `Discovering topics from ${dj.total.toLocaleString()} representative bookmarks${dj.status === 'paused' ? ` — paused (${dj.pausedReason})` : ''}`), h('div', { class: 'btn-row' }, dj.status === 'paused' ? h('button', { class: 'btn', onclick: () => act({ type: 'jobControl', job: 'discover', action: 'resume' }).then(ctx.refresh) }, 'Resume') : h('button', { class: 'btn', onclick: () => act({ type: 'jobControl', job: 'discover', action: 'pause' }).then(ctx.refresh) }, 'Pause'), h('button', { class: 'btn', onclick: () => act({ type: 'jobControl', job: 'discover', action: 'cancel' }).then(ctx.refresh) }, 'Cancel')))
    : dj?.lastError ? h('div', { class: 'notice notice-warn' }, dj.lastError) : null;

  const userTaxonomyInput = st.mode === 'user'
    ? h('label', { class: 'field' }, h('span', null, 'Your categories ', h('span', { class: 'hint' }, '(one per line; indent with two spaces for subcategories; add aliases after "|")')), h('textarea', { class: 'input', placeholder: 'Astronomy\n  Celestial Mechanics | orbits, astrodynamics\nReal Estate', oninput: (e: Event) => (st.userText = (e.target as HTMLTextAreaElement).value) }, st.userText))
    : null;

  // Structure analysis (improve mode)
  let structurePanel: HTMLElement | null = null;
  if (st.mode === 'improve') {
    const kids = new Map<string, string[]>();
    for (const b of flat.bookmarks) (kids.get(b.parentId) ?? kids.set(b.parentId, []).get(b.parentId)!).push(b.id);
    const infos: FolderInfo[] = flat.folders.map((f) => ({ id: f.id, title: f.title, path: f.path, bookmarkIds: kids.get(f.id) ?? [] }));
    const items = new Map(flat.bookmarks.map((b) => [b.id, { id: b.id, title: b.title, url: b.url, folderPath: b.path }]));
    const findings = analyseStructure(infos, items);
    structurePanel = h('details', { open: findings.length < 15 }, h('summary', null, `Suggestions for your existing folders (${findings.length})`), findings.length ? h('ul', null, ...findings.slice(0, 200).map((f) => h('li', null, h('span', { class: 'badge' }, f.kind), ' ', bidi(f.message), f.suggestion ? h('span', { class: 'muted' }, ` ${f.suggestion}`) : null))) : h('p', { class: 'muted' }, 'No structural issues found.'));
  }

  // ── Draft / current taxonomy panel
  const classifyCounts = (tax: Taxonomy): { counts: Map<string, number>; unresolved: number } => {
    const clf = new RulesClassifier(tax);
    const counts = new Map<string, number>();
    let unresolved = 0;
    for (const b of flat.bookmarks) {
      const a = clf.classify({ id: b.id, title: b.title, url: b.url, folderPath: b.path }, 0);
      if (!a.categoryId) unresolved++;
      else for (const id of clf.pathIds(a.categoryId)) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return { counts, unresolved };
  };

  let draftPanel: HTMLElement | null = null;
  if (draft) {
    const ds = taxonomyStats(draft);
    const { counts } = draft.discoveredBy === 'rules' ? classifyCounts(draft) : { counts: new Map<string, number>() };
    const issues = consistencyPass(draft, counts, flat.bookmarks.length);
    draftPanel = h(
      'div',
      { class: 'panel', id: 'organize-draft' },
      h('h2', null, 'Draft taxonomy', h('span', { class: 'badge badge-warn' }, 'Not yet approved')),
      h('p', { class: 'muted' }, `${ds.total} categories, ${ds.top} top-level, up to ${plural(ds.maxDepth, 'level')}. Source: ${draft.discoveredBy === 'rules' ? 'offline rules (title/URL vocabulary)' : draft.discoveredBy === 'gemini' ? 'Gemini (sample-based)' : draft.discoveredBy === 'chrome-ai' ? 'on-device AI (sample-based)' : draft.discoveredBy === 'folders' ? 'your existing folders' : 'your list'}. Rename, merge, split, move, pin, reject or exclude categories before approving. Nothing moves until you approve a preview.`),
      ...(draft.notes ?? []).map((n) => h('div', { class: 'notice' }, n)),
      issues.length ? h('details', null, h('summary', null, `Consistency check: ${issues.length} suggestion(s)`), h('ul', null, ...issues.slice(0, 100).map((i) => h('li', null, i.message)))) : null,
      taxonomyTree(draft, 'draft', counts, ctx.refresh, true),
      h('div', { class: 'btn-row', style: 'margin-top:12px' }, h('button', { class: 'btn', onclick: async () => { const v = await promptDialog({ title: 'Add top-level category', label: 'Name' }); if (v && (await act({ type: 'taxonomyEdit', target: 'draft', edit: { op: 'add', input: { name: v, parentId: null, origin: 'user' } } }))) await ctx.refresh(); } }, 'Add top-level category'), h('button', { class: 'btn btn-primary', onclick: async () => { if (t && !(await confirmDialog({ title: 'Replace the approved taxonomy?', body: [h('p', null, 'Approving this draft replaces the current taxonomy. Existing categorizations will be recomputed; manual assignments are kept.')], confirm: 'Approve draft' }))) return; if (await act({ type: 'taxonomyAdopt' }, 'Taxonomy approved and frozen (versioned, stable category IDs).')) await ctx.refresh(); } }, 'Approve taxonomy'), h('button', { class: 'btn', onclick: () => act({ type: 'taxonomyDiscardDraft' }).then(ctx.refresh) }, 'Discard draft')),
    );
  }

  // ── Approved taxonomy + categorization
  let approvedPanel: HTMLElement | null = null;
  let reviewPanel: HTMLElement | null = null;
  let planPanel: HTMLElement | null = null;
  if (t) {
    const ts = taxonomyStats(t);
    const stored = await repo.assignments.all();
    const overrides = await repo.overrides.all();
    const rules = await repo.rules();
    const clf = new RulesClassifier(t);
    const now = Date.now();
    const resolved = new Map<string, Assignment>();
    const counts = new Map<string, number>();
    const bands = { high: 0, medium: 0, low: 0, none: 0, ai: 0, stale: 0 };
    const prot = new Set(ctx.settings.protectedFolderIds);
    for (const b of flat.bookmarks) {
      const s = stored.get(b.id);
      const a = resolveAssignment({ id: b.id, title: b.title, url: b.url, folderPath: b.path, pathIds: b.pathIds }, { taxonomy: t, protectedFolderIds: prot, excludedBookmarkIds: new Set(), overrides, rules, stored: s, classify: (x) => clf.classify(x, now), now });
      resolved.set(b.id, a);
      if (s && a !== s && (s.provider === 'gemini' || s.provider === 'chrome-ai')) bands.stale++;
      if (a.provider === 'gemini' || a.provider === 'chrome-ai') bands.ai++;
      if (a.categoryId) for (const id of clf.pathIds(a.categoryId)) counts.set(id, (counts.get(id) ?? 0) + 1);
      if (!a.categoryId || a.needsReview) bands.none++;
      else bands[a.band ?? 'low']++;
    }
    const cj = ctx.jobs.classify;
    const classifyRunning = cj && (cj.status === 'running' || cj.status === 'paused');
    const scopeSel2 = h('select', { class: 'input', 'aria-label': 'Which bookmarks to send to AI' }, h('option', { value: 'uncertain' }, 'Only bookmarks the offline rules are unsure about'), h('option', { value: 'all' }, 'All bookmarks'));
    scopeSel2.value = ctx.settings.ai.scope;
    const startClassify = async () => {
      const scope = scopeSel2.value as 'uncertain' | 'all';
      if (!(await startWithProvider(ctx, st.provider, 'classify', scope, folderIds))) return;
      await act({ type: 'classifyStart', provider: st.provider, scope, folderIds }, st.provider === 'rules' ? 'Categorizing with offline rules…' : 'Categorization started; it resumes automatically after interruptions.');
      await ctx.refresh();
    };
    const usage = cj ? await repo.ledger((cj.options as { ledgerKey?: string }).ledgerKey ?? '') : undefined;
    approvedPanel = h(
      'div',
      { class: 'panel', id: 'organize-taxonomy' },
      h('h2', null, 'Approved taxonomy', h('span', { class: 'badge badge-ok' }, `v${t.version}`)),
      h('p', { class: 'muted' }, `${ts.total} categories, ${ts.top} top-level, up to ${plural(ts.maxDepth, 'level')}. Counts reflect current categorizations. Edits create a new version.`),
      h('details', null, h('summary', null, 'Show and edit categories'), taxonomyTree(t, 'current', counts, ctx.refresh, true)),
      h('h3', { style: 'margin-top:12px' }, 'Categorize bookmarks'),
      h('div', { class: 'cards' }, metric(bands.high, 'High confidence'), metric(bands.medium, 'Medium confidence'), metric(bands.low, 'Low confidence'), metric(bands.none, 'Needs review / unresolved'), metric(bands.ai, 'Categorized by AI')),
      h('p', { class: 'small muted' }, 'Confidence bands combine evidence strength and agreement; they are not calibrated probabilities. Offline results come from titles, URLs and (weakly) existing folder names.'),
      classifyRunning
        ? h('div', { class: 'grid' }, progress(cj.completed + cj.failed + cj.skipped, cj.total, 'Categorization progress'), h('div', { class: 'small muted' }, `${(cj.completed + cj.failed + cj.skipped).toLocaleString()} of ${cj.total.toLocaleString()}${cj.status === 'paused' ? ` — paused (${cj.pausedReason})` : ''}${usage ? ` · ${usage.requests} requests, ~${(usage.inputTokens + usage.outputTokens).toLocaleString()} tokens, ≈$${usage.estimatedCostUsd.toFixed(3)}${usage.anyEstimated ? ' (partly estimated)' : ''}` : ''}`), h('div', { class: 'btn-row' }, cj.status === 'paused' ? h('button', { class: 'btn', onclick: () => act({ type: 'jobControl', job: 'classify', action: 'resume' }).then(ctx.refresh) }, 'Resume') : h('button', { class: 'btn', onclick: () => act({ type: 'jobControl', job: 'classify', action: 'pause' }).then(ctx.refresh) }, 'Pause'), h('button', { class: 'btn', onclick: () => act({ type: 'jobControl', job: 'classify', action: 'cancel' }).then(ctx.refresh) }, 'Cancel')))
        : h('div', { class: 'toolbar' }, st.provider !== 'rules' ? scopeSel2 : null, h('button', { class: 'btn btn-primary', onclick: startClassify }, st.provider === 'rules' ? 'Categorize with offline rules' : `Categorize with ${PROVIDER_LABEL[st.provider]}`)),
      cj?.status === 'completed' && usage ? h('p', { class: 'small muted' }, `Last run: ${usage.requests} requests, ~${(usage.inputTokens + usage.outputTokens).toLocaleString()} tokens, ≈$${usage.estimatedCostUsd.toFixed(3)}${usage.anyEstimated ? ' (partly estimated)' : ''}.`) : null,
    );

    // Needs Review
    const review = flat.bookmarks.filter((b) => {
      const a = resolved.get(b.id)!;
      return a.provider !== 'protected' && a.provider !== 'user' && (!a.categoryId || a.needsReview);
    });
    const bulkSel = categoryOptions(t, h('select', { class: 'input', 'aria-label': 'Assign selected to category' }));
    const assignSelected = async () => {
      const ids = [...st.reviewSel].filter((id) => flat.byId.has(id));
      if (!ids.length || !bulkSel.value) return toast('Select bookmarks and a category first.');
      await act({ type: 'assign', bookmarkIds: ids, categoryId: bulkSel.value === '__keep' ? null : bulkSel.value }, `Updated ${plural(ids.length, 'bookmark')}.`);
      st.reviewSel.clear();
      await ctx.refresh();
    };
    reviewPanel = h(
      'div',
      { class: 'panel', id: 'organize-review' },
      h('h2', null, 'Needs review', h('span', { class: 'badge badge-warn' }, review.length.toLocaleString())),
      h('p', { class: 'muted' }, 'Ambiguous or weakly supported items stay where they are unless you assign them. Your choices are remembered and override automatic categorization.'),
      h('div', { class: 'toolbar' }, bulkSel, h('button', { class: 'btn', onclick: assignSelected }, 'Assign selected')),
      dataTable({
        caption: 'Bookmarks needing review',
        rows: review,
        id: (b: FlatBookmark) => b.id,
        pageSize: ctx.settings.ui.pageSize,
        selectable: true,
        selected: st.reviewSel,
        page: st.reviewPage,
        onPage: (p) => (st.reviewPage = p),
        empty: 'Nothing needs review.',
        columns: [
          { label: 'Bookmark', cell: (b) => h('div', null, h('div', { class: 'title-cell' }, bidi(b.title || '(untitled)')), h('div', { class: 'url' }, b.url)) },
          { label: 'Current folder', cell: (b) => bidi(b.path.join(' › '), 'small') },
          { label: 'Suggestion', cell: (b) => { const a = resolved.get(b.id)!; return h('div', null, a.categoryId ? h('div', { class: 'small' }, pathLabel(t, a.categoryId)) : h('span', { class: 'muted small' }, 'None'), a.suggestedCategory ? h('div', { class: 'small' }, `New category suggested: ${a.suggestedCategory.name}`) : null, h('div', { class: 'small muted' }, bidi(a.rationale))); } },
          { label: 'Why review', cell: (b) => bandBadge(resolved.get(b.id)!.band, resolved.get(b.id)!.needsReview) },
        ],
      }),
    );

    // Preview plan
    planPanel = renderPlanPanel(ctx, t, plan);
  }

  append(
    el,
    sectionHead('Organization Preview', 'Discover a subject hierarchy from your own bookmarks, review and edit it, categorize, then preview every move before anything changes. Moves go into a new LinkSpruce folder; your original folders are kept.'),
    h(
      'div',
      { class: 'panel', id: 'organize-discover' },
      h('h2', null, '1. Build a taxonomy'),
      h('div', { class: 'toolbar' }, modeSel, st.mode === 'discover' ? providerSel : null, granSel, langSel, h('label', { class: 'small' }, 'Scope ', scopeSel)),
      st.mode !== 'discover' ? h('div', { class: 'toolbar' }, h('span', { class: 'small muted' }, 'Provider for categorizing later:'), providerSel) : null,
      (st.provider === 'rules' || (st.provider === 'auto' && avail?.['chrome-ai']?.state !== 'available')) && st.mode === 'discover' ? h('div', { class: 'notice notice-warn' }, 'Offline rules give a useful starting structure from title and URL vocabulary, but they are not AI discovery. For collection-specific topics, use on-device AI or Gemini (your key) — or refine the draft by hand.') : null,
      autoNote,
      userTaxonomyInput,
      structurePanel,
      h('div', { class: 'btn-row' }, h('button', { class: 'btn btn-primary', onclick: discover, disabled: !!(dj && dj.status === 'running') }, st.mode === 'discover' ? 'Discover structure' : st.mode === 'improve' ? 'Build draft from my folders' : 'Create draft'), downloadBtn),
      discoveryProgress,
    ),
    draftPanel ?? (t ? h('span') : h('div', { class: 'panel empty' }, 'No taxonomy yet. Build one above to start organizing.')),
    approvedPanel ?? h('span'),
    reviewPanel ?? h('span'),
    planPanel ?? h('span'),
  );
}

function renderPlanPanel(ctx: Ctx, t: Taxonomy, plan: OrganizePlan | undefined): HTMLElement {
  const st = ctx.memo.get('org') as OrgState;
  const panel = h('div', { class: 'panel', id: 'organize-preview' });
  const dest = ctx.settings.destinationRootId ? ctx.tree.flat.byId.get(ctx.settings.destinationRootId) : undefined;
  const destName = dest ? [...dest.path, dest.title].join(' › ') : (ctx.tree.root.children ?? []).find((c) => c.id === ctx.tree.roots.other)?.title ?? 'Other bookmarks';
  const build = async () => {
    if (await act({ type: 'planBuild' })) await ctx.refresh();
  };
  if (!plan || plan.taxonomyId !== t.id || plan.taxonomyVersion !== t.version) {
    mount(
      panel,
      h('h2', null, '2. Preview changes'),
      plan ? h('div', { class: 'notice notice-warn' }, 'The previous preview is out of date because the taxonomy changed. Build a new one.') : null,
      h('p', null, `Bookmarks will be moved into “${destName} › ${ctx.settings.rootFolderName}”. Only ${ctx.settings.includeBands.join(' and ')}-confidence and manually assigned items are included; protected folders and Needs Review items stay where they are. Change the destination in Settings.`),
      h('button', { class: 'btn btn-primary', onclick: build }, 'Build preview'),
    );
    return panel;
  }
  const newFolders = plan.folders.filter((f) => !f.existingId);
  const perCat = new Map<string, number>();
  for (const m of plan.moves) perCat.set(m.categoryId, (perCat.get(m.categoryId) ?? 0) + 1);
  const apply = async () => {
    const ok = await confirmDialog({
      title: `Move ${plural(plan.moves.length, 'bookmark')}?`,
      body: [
        h('p', null, `${plan.moves.length.toLocaleString()} bookmarks will move into “${plan.generatedRoot.name}”${newFolders.length ? `, creating ${plural(newFolders.length, 'folder')}` : ''}. Original folders are not deleted, even if they become empty.`),
        h('p', null, 'LinkSpruce first saves a complete, verified snapshot and records each step, so you can undo the whole batch. If a bookmark changes in the meantime (another device, another extension), that step is skipped and reported instead of overwriting the change.'),
      ],
      confirm: 'Apply changes',
    });
    if (!ok) return;
    if (await act({ type: 'planApply', planId: plan.id, fingerprint: plan.fingerprint }, 'Applying… progress and Undo are in Backup & Restore.')) await ctx.refresh();
  };
  mount(
    panel,
    h('h2', null, '2. Preview changes', h('span', { class: 'badge badge-info' }, `${plan.moves.length.toLocaleString()} moves`)),
    h('div', { class: 'cards' }, metric(plan.moves.length, 'Bookmarks to move'), metric(newFolders.length, 'New folders'), metric(plan.folders.length - newFolders.length, 'Reused folders'), metric(plan.skipped.unresolved + plan.skipped.band, 'Left for review'), metric(plan.skipped.protected, 'Protected'), metric(plan.skipped['already-there'], 'Already in place')),
    h('details', null, h('summary', null, 'Target folder tree'), h('ul', { class: 'tree' }, ...plan.folders.filter((f) => f.path.length === 1).map(function nodeFor(f): HTMLElement {
      const kids = plan.folders.filter((x) => x.path.length === f.path.length + 1 && x.path.slice(0, -1).join('\u0001') === f.path.join('\u0001'));
      return h('li', null, h('div', { class: 'tree-row' }, h('span', { class: 'name' }, f.path[f.path.length - 1]!), h('span', { class: 'badge' }, `${(perCat.get(f.categoryId) ?? 0).toLocaleString()} moving here`), f.existingId ? h('span', { class: 'badge badge-ok' }, 'exists') : h('span', { class: 'badge badge-info' }, 'new')), kids.length ? h('ul', { class: 'tree' }, ...kids.map(nodeFor)) : null);
    }))),
    dataTable({
      caption: 'Planned moves',
      rows: plan.moves,
      id: (m) => m.bookmarkId,
      pageSize: ctx.settings.ui.pageSize,
      page: st.movesPage,
      onPage: (p) => (st.movesPage = p),
      empty: 'Nothing to move: everything is already organized or needs review.',
      columns: [
        { label: 'Bookmark', cell: (m) => h('div', null, h('div', { class: 'title-cell' }, bidi(m.title || '(untitled)')), h('div', { class: 'url' }, m.url)) },
        { label: 'From', cell: (m) => bidi(m.fromPath.join(' › '), 'small') },
        { label: 'To', cell: (m) => h('span', { class: 'small' }, pathLabel(t, m.categoryId)) },
        { label: 'Confidence', cell: (m) => bandBadge(m.band) },
        { label: 'Why', cell: (m) => bidi(m.rationale, 'small muted') },
      ],
    }),
    h('div', { class: 'btn-row', style: 'margin-top:12px' }, h('button', { class: 'btn btn-primary', onclick: apply, disabled: !plan.moves.length }, 'Apply changes…'), h('button', { class: 'btn', onclick: build }, 'Rebuild preview')),
  );
  return panel;
}
