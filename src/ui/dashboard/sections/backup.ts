/** Backup & Restore: snapshots, JSON export, validated restore, HTML file analysis/import, batch history with Undo. */
import { backupFilename, makeBackupFile, toSnap, validateRestoreFile, type SnapNode } from '../../../core/backup.ts';
import { inventory, offlineDraft } from '../../../core/discovery/discovery.ts';
import { RulesClassifier } from '../../../core/classify/classifier.ts';
import type { BatchHeader } from '../../../core/journal.ts';
import { flattenImported, parseNetscapeBookmarks, DEFAULT_IMPORT_LIMITS } from '../../../core/netscape.ts';
import { putChunked, getChunked } from '../../../core/store.ts';
import { freeze, pathLabel } from '../../../core/taxonomy/taxonomy.ts';
import { batches, snapshots, store } from '../../shared/data.ts';
import { append, confirmDialog, downloadText, fmtDate, h, plural, readFileText, toast } from '../../shared/dom.ts';
import { dataTable } from '../../shared/table.ts';
import type { Ctx } from '../dashboard.ts';
import { act, folderSelect, memoGet, metric, sectionHead } from './common.ts';

const MAX_FILE = 64 * 1024 * 1024;

const KIND_LABEL: Record<BatchHeader['kind'], string> = {
  organize: 'Organize',
  dedupe: 'Remove duplicates',
  cleanup: 'Remove not-found',
  restore: 'Restore',
  import: 'Import',
  autofile: 'Auto-file',
  undo: 'Undo',
};

export async function renderBackup(el: HTMLElement, ctx: Ctx): Promise<void> {
  const st = memoGet(ctx.memo, 'backup', () => ({ analysis: null as HTMLElement | null, restorePreview: null as HTMLElement | null, page: 0 }));
  const [snaps, bs] = await Promise.all([snapshots(), batches()]);
  const version = chrome.runtime.getManifest().version;

  const exportNow = async () => {
    const [root] = await chrome.bookmarks.getTree();
    const tags: Record<string, string[]> = {};
    const file = makeBackupFile(toSnap(root as never), version, new Date(), { tags, taxonomyId: ctx.taxonomy?.id });
    downloadText(backupFilename(new Date()), JSON.stringify(file, null, 1));
  };
  const downloadSnapshot = async (id: string, createdAt: number) => {
    const root = await getChunked<SnapNode>(store, `snapshot:${id}`);
    if (!root) return toast('Snapshot not found', 'error');
    downloadText(backupFilename(new Date(createdAt)), JSON.stringify(makeBackupFile(root, version, new Date(createdAt)), null, 1));
  };

  const destSel = folderSelect(ctx.tree, { value: ctx.tree.roots.other ?? '', writableOnly: true, label: 'Restore into folder' });

  const onRestoreFile = async (file: File) => {
    let text: string;
    try {
      text = await readFileText(file, MAX_FILE);
    } catch (e) {
      return toast((e as Error).message, 'error');
    }
    const v = validateRestoreFile(text);
    if (!v.ok || !v.root) {
      st.restorePreview = h('div', { class: 'notice notice-bad', role: 'alert' }, `This file can't be restored: ${v.errors.join('; ')}`);
      return ctx.refresh();
    }
    const root = v.root;
    const label = v.source === 'netscape-html' ? 'Imported Bookmarks' : 'Restored Bookmarks';
    const go = async () => {
      if (!destSel.value) return toast('Choose a destination folder.', 'error');
      const ok = await confirmDialog({ title: `${label === 'Imported Bookmarks' ? 'Import' : 'Restore'} ${plural(v.counts!.bookmarks, 'bookmark')}?`, body: [h('p', null, `A new folder “${label} <date>” will be created inside the chosen folder. Your current bookmarks are not changed or deleted. A snapshot is taken first so this can be undone.`), h('p', { class: 'small muted' }, 'New bookmarks get new IDs, and original creation dates cannot be restored by Chrome.')], confirm: label === 'Imported Bookmarks' ? 'Import' : 'Restore' });
      if (!ok) return;
      await putChunked(store, 'restore:pending', root);
      if (await act({ type: 'restoreApply', parentId: destSel.value, label }, 'Restoring into a new folder…')) {
        st.restorePreview = null;
        await ctx.refresh();
      }
    };
    st.restorePreview = h(
      'div',
      { class: 'notice' },
      h('p', null, h('b', null, file.name), ` — ${v.source === 'netscape-html' ? 'bookmarks HTML export' : 'LinkSpruce JSON backup'}: ${v.counts!.bookmarks.toLocaleString()} bookmarks, ${v.counts!.folders.toLocaleString()} folders, depth ${v.counts!.maxDepth}.`),
      ...v.warnings.map((w) => h('p', { class: 'small' }, w)),
      h('div', { class: 'toolbar' }, h('label', { class: 'small' }, 'Into ', destSel), h('button', { class: 'btn btn-primary', onclick: go }, label === 'Imported Bookmarks' ? 'Import into a new folder…' : 'Restore into a new folder…')),
    );
    await ctx.refresh();
  };

  const onAnalyzeFile = async (file: File) => {
    let text: string;
    try {
      text = await readFileText(file, DEFAULT_IMPORT_LIMITS.maxBytes);
    } catch (e) {
      return toast((e as Error).message, 'error');
    }
    try {
      const t0 = performance.now();
      const r = parseNetscapeBookmarks(text);
      const flat = flattenImported(r.root);
      const items = flat.map((f) => ({ id: f.node.sourceId, title: f.node.title, url: f.node.url ?? '', folderPath: f.path }));
      const inv = inventory(items);
      const draft = freeze(offlineDraft(inv, 'tax_file_preview', Date.now(), ctx.settings.granularity).taxonomy, Date.now());
      const clf = new RulesClassifier(draft);
      const counts = new Map<string, number>();
      let unresolved = 0;
      for (const it of items) {
        const a = clf.classify(it, 0);
        if (!a.categoryId || a.needsReview) unresolved++;
        const top = a.categoryId ? clf.pathIds(a.categoryId)[0] : undefined;
        if (top) counts.set(top, (counts.get(top) ?? 0) + 1);
      }
      const ms = Math.round(performance.now() - t0);
      st.analysis = h(
        'div',
        null,
        h('div', { class: 'cards' }, metric(r.stats.bookmarks, 'Bookmark entries'), metric(r.stats.folders, 'Folders'), metric(inv.uniqueUrls, 'Unique URLs'), metric(inv.repeatedUrlInstances, 'Repeated URL entries'), metric(inv.weakTitles, 'Generic titles'), metric(r.stats.maxDepth, 'Max depth')),
        h('p', { class: 'small muted' }, `Parsed locally in ${ms} ms. Raw tags found: ${r.stats.rawAnchorTags.toLocaleString()} links, ${r.stats.rawFolderHeadings.toLocaleString()} folder headings. ${r.stats.droppedIcons.toLocaleString()} embedded icons were ignored. Schemes: ${Object.entries(r.stats.schemes).map(([k, v]) => `${k} ${v}`).join(', ')}.`),
        ...r.warnings.map((w) => h('div', { class: 'notice notice-warn' }, w)),
        h('p', null, `Languages (by script): ${Object.entries(inv.languages).map(([k, v]) => `${k} ${v}`).join(', ')}.`),
        h('h3', null, 'Offline topic preview (not applied)'),
        h('p', { class: 'small muted' }, `${unresolved.toLocaleString()} entries would need review or AI help. Nothing in Chrome changes during file analysis.`),
        h('ul', { class: 'tree' }, ...draft.categories.filter((c) => c.parentId === null).map((c) => h('li', null, h('div', { class: 'tree-row' }, h('span', { class: 'name' }, pathLabel(draft, c.id)), h('span', { class: 'badge' }, (counts.get(c.id) ?? 0).toLocaleString()))))),
      );
    } catch (e) {
      st.analysis = h('div', { class: 'notice notice-bad' }, (e as Error).message);
    }
    await ctx.refresh();
  };

  const fileInput = (accept: string, onFile: (f: File) => void, label: string) =>
    h('label', { class: 'btn' }, label, h('input', { type: 'file', accept, class: 'sr-only', onchange: (e: Event) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) onFile(f); (e.target as HTMLInputElement).value = ''; } }));

  const undo = async (b: BatchHeader) => {
    const ok = await confirmDialog({ title: `Undo “${b.label}”?`, body: [h('p', null, 'LinkSpruce restores moved bookmarks to their previous folders and positions, recreates removed bookmarks (with new IDs), and removes folders it created only if they are now empty. Changes you made afterwards are preserved; anything that conflicts is reported instead of overwritten.')], confirm: 'Undo' });
    if (!ok) return;
    const r = await act<BatchHeader>({ type: 'batchUndo', batchId: b.id });
    if (r) toast(r.status === 'applied' ? 'Undone.' : `Partly undone: ${r.counts.done} restored, ${r.counts.conflict} conflicts, ${r.counts.failed} failed. See details below.`, r.status === 'applied' ? 'success' : 'info');
    await ctx.refresh();
  };

  const recent = bs.filter((b) => b.kind !== 'autofile' || b.undoOf);
  const totalBytes = snaps.reduce((n, s) => n + s.bytes, 0);
  append(
    el,
    sectionHead('Backup & Restore', 'Full snapshots are taken automatically before every bulk change. Export a backup to keep your own copy; restores always go into a new folder and never replace your current bookmarks.', h('button', { class: 'btn btn-primary', onclick: exportNow }, 'Download backup (JSON)'), h('button', { class: 'btn', onclick: () => act({ type: 'snapshotNow' }, 'Snapshot saved.').then(ctx.refresh) }, 'Take snapshot now')),
    h('div', { class: 'notice' }, 'Backups contain your bookmark titles and URLs, which may include private links. They never contain API keys or passwords. Snapshots are stored inside the extension and are deleted if you uninstall LinkSpruce — download a copy to keep one.'),
    h(
      'div',
      { class: 'panel', id: 'backup-history' },
      h('h2', null, 'Recent changes'),
      dataTable({
        caption: 'Recent bulk changes',
        rows: recent,
        id: (b) => b.id,
        pageSize: 20,
        page: st.page,
        onPage: (p) => (st.page = p),
        empty: 'No bulk changes yet.',
        columns: [
          { label: 'When', cell: (b) => h('span', { class: 'small' }, fmtDate(b.createdAt)) },
          { label: 'Change', cell: (b) => h('div', null, h('span', { class: 'badge badge-brand' }, KIND_LABEL[b.kind]), ' ', b.label) },
          { label: 'Result', cell: (b) => h('div', { class: 'small' }, b.status === 'running' ? 'Running…' : `${b.counts.done} done${b.counts.conflict ? `, ${b.counts.conflict} conflicts` : ''}${b.counts.failed ? `, ${b.counts.failed} failed` : ''}${b.counts.skipped ? `, ${b.counts.skipped} skipped` : ''}`, b.undoneBy ? h('div', { class: 'muted' }, 'Undone') : null) },
          { label: '', cell: (b) => (b.status !== 'running' && !b.undoneBy && b.kind !== 'undo' && b.counts.done > 0 ? h('button', { class: 'btn btn-small', onclick: () => undo(b) }, 'Undo') : h('span')) },
        ],
      }),
    ),
    h(
      'div',
      { class: 'panel', id: 'backup-snapshots' },
      h('h2', null, 'Snapshots', h('span', { class: 'badge' }, `${snaps.length} · ${(totalBytes / 1048576).toFixed(1)} MB`)),
      h('p', { class: 'muted small' }, 'The newest 12 snapshots (up to 120 MB) are kept; older ones are deleted automatically.'),
      dataTable({
        caption: 'Snapshots',
        rows: snaps,
        id: (s) => s.id,
        pageSize: 20,
        empty: 'No snapshots yet.',
        columns: [
          { label: 'When', cell: (s) => h('span', { class: 'small' }, fmtDate(s.createdAt)) },
          { label: 'Reason', cell: (s) => h('span', { class: 'small' }, s.reason) },
          { label: 'Contents', cell: (s) => h('span', { class: 'small' }, `${s.bookmarks.toLocaleString()} bookmarks, ${s.folders.toLocaleString()} folders`) },
          {
            label: '',
            cell: (s) =>
              h(
                'div',
                { class: 'btn-row' },
                h('button', { class: 'btn btn-small', onclick: () => downloadSnapshot(s.id, s.createdAt) }, 'Download'),
                h('button', { class: 'btn btn-small', onclick: async () => { const sel = folderSelect(ctx.tree, { value: ctx.tree.roots.other ?? '', writableOnly: true, label: 'Restore into' }); if (await confirmDialog({ title: 'Restore this snapshot into a new folder?', body: [h('p', null, `${s.bookmarks.toLocaleString()} bookmarks will be recreated inside a new “Restored Bookmarks” folder. Current bookmarks are not changed.`), sel], confirm: 'Restore' })) await act({ type: 'snapshotRestore', id: s.id, parentId: sel.value }, 'Restoring…').then(ctx.refresh); } }, 'Restore…'),
                h('button', { class: 'btn btn-small', onclick: async () => { if (await confirmDialog({ title: 'Delete snapshot?', body: [h('p', null, 'This cannot be undone.')], confirm: 'Delete', danger: true })) await act({ type: 'snapshotDelete', id: s.id }).then(ctx.refresh); } }, 'Delete'),
              ),
          },
        ],
      }),
    ),
    h(
      'div',
      { class: 'split' },
      h('div', { class: 'panel', id: 'backup-restore' }, h('h2', null, 'Restore from a file'), h('p', { class: 'muted' }, 'Accepts LinkSpruce JSON backups and Chrome/Netscape bookmarks HTML exports. The file is checked (type, version, size, depth, URLs) and previewed first. Script URLs (javascript:, data:) are skipped.'), fileInput('.json,.html,.htm,application/json,text/html', onRestoreFile, 'Choose file…'), st.restorePreview ?? null),
      h('div', { class: 'panel', id: 'backup-analyze' }, h('h2', null, 'Analyze a bookmarks HTML file'), h('p', { class: 'muted' }, 'Inspect an exported bookmarks file locally — counts, languages, repeated links and an offline topic preview — without importing anything or changing Chrome. Links are never visited and embedded icons are ignored.'), fileInput('.html,.htm,text/html', onAnalyzeFile, 'Choose HTML file…'), st.analysis ?? null),
    ),
  );
}
