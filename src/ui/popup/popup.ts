/** Popup: compact status, job progress/controls, auto-filing state, Open Dashboard. */
import { findDuplicates } from '../../core/duplicates.ts';
import type { JobState } from '../../core/jobs.ts';
import { send } from '../../shared/messages.ts';
import { activity, jobs, loadTree, onStateChange, repo, settings } from '../shared/data.ts';
import { applyTheme, bidi, debounce, fmtNum, h, mount, progress, toast } from '../shared/dom.ts';

const app = document.getElementById('app')!;

function openDashboard(hash = '') {
  void chrome.tabs.create({ url: chrome.runtime.getURL(`dashboard.html${hash}`) });
  window.close();
}

function jobBlock(label: string, key: 'audit' | 'classify' | 'discover', j: JobState | undefined): HTMLElement | null {
  if (!j || j.status === 'completed' || j.status === 'cancelled') return null;
  const done = j.completed + j.failed + j.skipped;
  const control = (action: 'pause' | 'resume' | 'cancel', text: string) =>
    h('button', { class: 'btn btn-small', onclick: () => send({ type: 'jobControl', job: key, action }).catch((e: Error) => toast(e.message, 'error')) }, text);
  return h(
    'section',
    { class: 'job', 'aria-label': label },
    h('div', { class: 'job-head' }, h('span', null, label), h('span', { class: 'badge badge-info' }, j.status === 'paused' ? `Paused${j.pausedReason && j.pausedReason !== 'user' ? ` (${j.pausedReason})` : ''}` : 'Running')),
    progress(done, j.total, `${label} progress`),
    h('div', { class: 'row small muted' }, h('span', null, `${fmtNum(done)} of ${fmtNum(j.total)}`), h('span', { class: 'btn-row' }, j.status === 'running' ? control('pause', 'Pause') : control('resume', 'Resume'), control('cancel', 'Cancel'))),
  );
}

async function render(): Promise<void> {
  const [s, t, j, acts] = await Promise.all([settings(), loadTree(), jobs(), activity()]);
  applyTheme(s.ui.theme);
  const health = await repo.health.all();
  let restricted = 0;
  let notFound = 0;
  for (const b of t.flat.bookmarks) {
    const r = health.get(b.id);
    if (!r || r.url !== b.url) continue;
    if (r.status === 'not-found') notFound++;
    else if (r.status === 'access-restricted') restricted++;
  }
  const dups = findDuplicates(t.flat.bookmarks);
  const lastFiled = acts.find((a) => a.kind === 'filed' && !a.undone);

  const autoBlock = s.autoFile.enabled
    ? h(
        'section',
        { class: 'job', 'aria-label': 'Auto-file new bookmarks' },
        h('div', { class: 'job-head' }, h('span', null, 'Auto-file new bookmarks'), h('span', { class: `badge ${s.autoFile.paused ? 'badge-warn' : 'badge-ok'}` }, s.autoFile.paused ? 'Paused' : 'On')),
        h('div', { class: 'row' }, h('span', { class: 'small muted' }, s.autoFile.paused ? 'New bookmarks are not being filed.' : 'New bookmarks are filed automatically.'), h('button', { class: 'btn btn-small', onclick: () => send({ type: 'autofilePause', paused: !s.autoFile.paused }).then(render) }, s.autoFile.paused ? 'Resume' : 'Pause')),
        lastFiled
          ? h(
              'div',
              { class: 'last-action' },
              h('div', null, 'Saved to ', h('b', null, (lastFiled.toPath ?? []).slice(1).join(' › ') || '—')),
              h('div', { class: 'muted' }, bidi(lastFiled.title)),
              h('div', { class: 'btn-row', style: 'margin-top:6px' }, h('button', { class: 'btn btn-small', onclick: () => send<{ message: string }>({ type: 'autofileUndo', activityId: lastFiled.id }).then((r) => toast(r.message)).then(render) }, 'Undo'), h('button', { class: 'btn btn-small', onclick: () => openDashboard('#activity') }, 'Change category')),
            )
          : null,
      )
    : h('section', { class: 'job' }, h('div', { class: 'job-head' }, 'Auto-file new bookmarks'), h('p', { class: 'small muted' }, 'Off. Turn it on to file newly saved bookmarks into your categories automatically.'), h('button', { class: 'btn btn-small', onclick: () => openDashboard('#settings-autofile') }, 'Set up'));

  mount(
    app,
    h('header', { class: 'popup-head' }, h('img', { src: 'icons/icon-48.png', alt: '' }), h('div', null, h('h1', null, 'LinkSpruce'), h('div', { class: 'tag' }, 'Less clutter. Better bookmarks.'))),
    h(
      'div',
      { class: 'stats' },
      h('div', { class: 'stat' }, h('b', null, fmtNum(t.flat.bookmarks.length)), h('span', null, 'Bookmarks')),
      h('div', { class: 'stat' }, h('b', null, fmtNum(dups.groups.length)), h('span', null, 'Potential duplicate groups')),
      h('div', { class: 'stat' }, h('b', null, fmtNum(notFound)), h('span', null, `Not found${restricted ? ` · ${restricted} restricted` : ''}`)),
    ),
    jobBlock('Link check', 'audit', j.audit),
    jobBlock('Categorization', 'classify', j.classify),
    jobBlock('Taxonomy discovery', 'discover', j.discover),
    autoBlock,
    h('div', { class: 'btn-row' }, h('button', { class: 'btn btn-primary', onclick: () => openDashboard('#overview') }, 'Open Dashboard'), h('button', { class: 'btn', onclick: () => openDashboard('#duplicates') }, 'Review duplicates')),
  );
}

void render().catch((e: Error) => mount(app, h('p', { class: 'notice notice-bad' }, `Could not load: ${e.message}`)));
onStateChange(debounce(() => void render(), 400));
