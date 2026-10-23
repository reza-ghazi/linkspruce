/**
 * LinkSpruce service worker entry. All listeners are registered
 * synchronously at top level so Chrome can wake the worker for them.
 * No keepalive loops: durable state lives in storage; alarms resume work.
 */
import { validateMsg, type Reply } from '../shared/messages.ts';
import { Background } from './app.ts';
import { chromeBookmarks, chromeStore, geminiKeyStore, hasOrigin } from './chrome-platform.ts';
import { getLanguageModel } from '../core/ai/chrome-ai.ts';

const ALARM = 'linkspruce-wake';

const bg = new Background({
  api: chromeBookmarks,
  store: chromeStore(),
  clock: { now: () => Date.now() },
  fetch: (input, init) => fetch(input, init),
  keyStore: geminiKeyStore,
  hasOrigin,
  wake: (at) => {
    if (at === null) {
      void chrome.alarms.clear(ALARM);
      return;
    }
    // Chrome enforces a 30 s minimum; a periodic alarm keeps resuming work while jobs are pending.
    void chrome.alarms.create(ALARM, { when: Math.max(Date.now() + 30_000, at), periodInMinutes: 0.5 });
  },
  languageModel: getLanguageModel,
  online: () => (typeof navigator === 'undefined' ? true : navigator.onLine !== false),
  appVersion: chrome.runtime.getManifest().version,
});

// ───────── bookmark events (auto-filing + reconciliation)
for (const ev of [chrome.bookmarks.onCreated, chrome.bookmarks.onChanged, chrome.bookmarks.onMoved, chrome.bookmarks.onRemoved] as Array<chrome.events.Event<() => void>>) {
  ev.addListener(() => bg.invalidateTree());
}
chrome.bookmarks.onCreated.addListener((id, node) => {
  void bg.ensureRecovered().then(() => bg.autofile.onCreated(id, node));
});
chrome.bookmarks.onChanged.addListener((id, info) => {
  void bg.ensureRecovered().then(() => bg.autofile.onChanged(id, info));
});
chrome.bookmarks.onMoved.addListener((id, info) => {
  void bg.ensureRecovered().then(() => bg.autofile.onMoved(id, info));
});
chrome.bookmarks.onRemoved.addListener((id) => {
  void bg.ensureRecovered().then(() => bg.autofile.onRemoved(id));
});
chrome.bookmarks.onImportBegan.addListener(() => {
  void bg.autofile.onImportBegan();
});
chrome.bookmarks.onImportEnded.addListener(() => {
  void bg.autofile.onImportEnded();
});

// ───────── wake-ups
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM) void bg.tick();
});
chrome.runtime.onStartup.addListener(() => {
  void bg.tick();
});
chrome.runtime.onInstalled.addListener((details) => {
  void bg.tick();
  if (details.reason === 'install') void chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html#welcome') });
});
chrome.permissions.onRemoved.addListener(() => {
  bg.invalidatePermissionCache();
});
chrome.permissions.onAdded.addListener(() => {
  bg.invalidatePermissionCache();
});

// Keep in-memory caches coherent with storage written by other contexts.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const keys = Object.keys(changes);
  if (keys.some((k) => k.startsWith('hl:'))) bg.repo.health.invalidate();
  if (keys.some((k) => k.startsWith('as:'))) bg.repo.assignments.invalidate();
  if (keys.some((k) => k.startsWith('ov:'))) bg.repo.overrides.invalidate();
});

// ───────── messages from extension pages only
const EXTENSION_ORIGIN = chrome.runtime.getURL('');

chrome.runtime.onMessage.addListener((raw, sender, sendResponse: (r: Reply) => void) => {
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(EXTENSION_ORIGIN)) {
    sendResponse({ ok: false, error: 'Forbidden sender' });
    return false;
  }
  const msg = validateMsg(raw);
  if (typeof msg === 'string') {
    sendResponse({ ok: false, error: msg });
    return false;
  }
  bg.handle(msg).then(
    (data) => sendResponse({ ok: true, data }),
    (e: unknown) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
  );
  return true; // async response
});

// Resume anything interrupted by the previous worker's termination.
void bg.tick();
