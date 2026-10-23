/** Dashboard shell: hash router, shared context, live refresh on state changes. */
import type { JobState } from '../../core/jobs.ts';
import type { Settings } from '../../core/settings.ts';
import type { Taxonomy } from '../../core/taxonomy/taxonomy.ts';
import { jobs, loadTree, onStateChange, settings, taxonomy, type TreeData } from '../shared/data.ts';
import { applyTheme, h, mount } from '../shared/dom.ts';
import { renderActivity } from './sections/activity.ts';
import { renderBackup } from './sections/backup.ts';
import { renderDuplicates } from './sections/duplicates.ts';
import { renderOrganize } from './sections/organize.ts';
import { renderOverview } from './sections/overview.ts';
import { renderSettings } from './sections/settings.ts';
import { renderWelcome } from './sections/welcome.ts';

export interface Ctx {
  tree: TreeData;
  settings: Settings;
  taxonomy: Taxonomy | undefined;
  jobs: { audit?: JobState; classify?: JobState; discover?: JobState };
  /** Re-render the current section (after an action). */
  refresh: () => Promise<void>;
  /** Section-local state survives re-renders (filters, pages, selections). */
  memo: Map<string, unknown>;
  /** Sub-anchor after "#section-" in the hash, e.g. "autofile". */
  anchor: string;
}

type Renderer = (el: HTMLElement, ctx: Ctx) => Promise<void> | void;

const SECTIONS: Record<string, { title: string; render: Renderer }> = {
  welcome: { title: 'Welcome', render: renderWelcome },
  overview: { title: 'Overview & Link Health', render: renderOverview },
  duplicates: { title: 'Duplicates Review', render: renderDuplicates },
  organize: { title: 'Organization Preview', render: renderOrganize },
  activity: { title: 'Auto-filing Activity', render: renderActivity },
  backup: { title: 'Backup & Restore', render: renderBackup },
  settings: { title: 'Settings & Privacy', render: renderSettings },
};

const main = document.getElementById('main')!;
const status = document.getElementById('topbar-status')!;
const memo = new Map<string, unknown>();
let rendering = false;
let pending = false;

function route(): { name: string; anchor: string } {
  const raw = location.hash.replace(/^#/, '') || 'overview';
  const [name = 'overview', ...rest] = raw.split('-');
  return { name: SECTIONS[name] ? name : 'overview', anchor: rest.join('-') };
}

async function render(focus = false): Promise<void> {
  if (rendering) {
    pending = true;
    return;
  }
  rendering = true;
  try {
    const { name, anchor } = route();
    const [tree, s, t, j] = await Promise.all([loadTree(), settings(), taxonomy(), jobs()]);
    applyTheme(s.ui.theme);
    document.title = `${SECTIONS[name]!.title} · LinkSpruce`;
    for (const a of document.querySelectorAll<HTMLAnchorElement>('.sidenav a')) {
      if (a.dataset.section === name) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
    const badges: HTMLElement[] = [];
    const jobBadge = (label: string, job?: JobState) => {
      if (job && (job.status === 'running' || job.status === 'paused')) {
        const done = job.completed + job.failed + job.skipped;
        badges.push(h('span', { class: `badge ${job.status === 'paused' ? 'badge-warn' : 'badge-info'}` }, `${label}: ${done.toLocaleString()}/${job.total.toLocaleString()}${job.status === 'paused' ? ' (paused)' : ''}`));
      }
    };
    jobBadge('Link check', j.audit);
    jobBadge('Categorizing', j.classify);
    jobBadge('Discovery', j.discover);
    if (s.autoFile.enabled) badges.push(h('span', { class: `badge ${s.autoFile.paused ? 'badge-warn' : 'badge-ok'}` }, s.autoFile.paused ? 'Auto-file paused' : 'Auto-file on'));
    mount(status, ...badges);
    const ctx: Ctx = { tree, settings: s, taxonomy: t, jobs: j, refresh: () => render(), memo, anchor };
    const container = h('div', { class: 'section' });
    await SECTIONS[name]!.render(container, ctx);
    const scrollY = window.scrollY;
    mount(main, container);
    if (focus) main.focus();
    else window.scrollTo(0, scrollY);
    if (anchor) document.getElementById(`${name}-${anchor}`)?.scrollIntoView();
  } catch (e) {
    mount(main, h('div', { class: 'notice notice-bad', role: 'alert' }, `Something went wrong: ${(e as Error).message}`));
  } finally {
    rendering = false;
    if (pending) {
      pending = false;
      void render();
    }
  }
}

window.addEventListener('hashchange', () => void render(true));
// Live updates: job progress, bookmark edits from other tabs/devices, background changes.
// Bulk operations emit thousands of bookmark events; coalesce them so the page
// re-renders at most every few seconds instead of competing with the work.
let lastRender = 0;
let queued: ReturnType<typeof setTimeout> | null = null;
const pendingKeys = new Set<string>();
onStateChange((keys) => {
  for (const k of keys) pendingKeys.add(k);
  if (queued) return;
  const burst = pendingKeys.has('bookmarks');
  const wait = Math.max(600, (burst ? 4000 : 600) - (Date.now() - lastRender));
  queued = setTimeout(() => {
    queued = null;
    const ks = [...pendingKeys];
    pendingKeys.clear();
    // Avoid re-rendering while the user is typing in a form field.
    const active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT') && !ks.some((k) => k.startsWith('job:'))) return;
    lastRender = Date.now();
    void render();
  }, wait);
});
void render();
