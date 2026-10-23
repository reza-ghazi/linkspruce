/** Launch Chromium (Chrome for Testing build bundled with Playwright) with the unpacked extension in an isolated profile. */
import { chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export interface Ext {
  context: BrowserContext;
  sw: Worker;
  id: string;
  profile: string;
  page: (path: string) => Promise<Page>;
  /** Run code in the service worker. */
  bg: <T>(fn: (arg: unknown) => Promise<T> | T, arg?: unknown) => Promise<T>;
  errors: string[];
  close: (keepProfile?: boolean) => Promise<void>;
}

export async function launch(opts: { dist?: string; profile?: string; fixturePort?: number } = {}): Promise<Ext> {
  const dist = resolve(opts.dist ?? 'dist-e2e');
  const profile = opts.profile ?? mkdtempSync(join(tmpdir(), 'linkspruce-e2e-'));
  const args = [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--no-first-run', '--no-default-browser-check'];
  if (opts.fixturePort) args.push(`--host-resolver-rules=MAP *.linkspruce-fixture.example 127.0.0.1`);
  const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, args, viewport: { width: 1280, height: 800 } });
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 30_000 });
  const id = sw.url().split('/')[2]!;
  const errors: string[] = [];
  const ext: Ext = {
    context,
    sw,
    id,
    profile,
    errors,
    page: async (path: string) => {
      const p = await context.newPage();
      p.on('console', (m) => { if (m.type() === 'error') errors.push(`${path}: ${m.text()}`); });
      p.on('pageerror', (e) => errors.push(`${path}: ${e.message}`));
      await p.goto(`chrome-extension://${id}/${path}`);
      return p;
    },
    bg: async (fn, arg) => {
      // The worker may have been restarted; always use the current one.
      const current = context.serviceWorkers().find((w) => w.url().includes(id)) ?? (await context.waitForEvent('serviceworker'));
      return current.evaluate(fn as never, arg) as never;
    },
    close: async (keepProfile = false) => {
      await context.close();
      if (!keepProfile) rmSync(profile, { recursive: true, force: true });
    },
  };
  return ext;
}

/** Seed bookmarks under "Other bookmarks" inside the isolated profile (synthetic data only). */
export async function seedBookmarks(ext: Ext, items: Array<{ path: string[]; title: string; url: string }>): Promise<string[]> {
  return ext.bg(async (arg) => {
    const list = arg as Array<{ path: string[]; title: string; url: string }>;
    const [root] = await chrome.bookmarks.getTree();
    const other = root!.children!.find((c) => (c as { folderType?: string }).folderType === 'other') ?? root!.children![1]!;
    const ids: string[] = [];
    const cache = new Map<string, string>();
    for (const it of list) {
      let parent = other.id;
      let key = '';
      for (const name of it.path) {
        key += `/${name}`;
        let id = cache.get(key);
        if (!id) {
          const kids = await chrome.bookmarks.getChildren(parent);
          id = kids.find((k) => !k.url && k.title === name)?.id ?? (await chrome.bookmarks.create({ parentId: parent, title: name })).id;
          cache.set(key, id);
        }
        parent = id;
      }
      ids.push((await chrome.bookmarks.create({ parentId: parent, title: it.title, url: it.url })).id);
    }
    return ids;
  }, items);
}

/** Send a LinkSpruce message from an extension page (validated by the background). */
export async function msg<T = unknown>(page: Page, m: Record<string, unknown>): Promise<T> {
  return page.evaluate(async (mm) => {
    const r = (await chrome.runtime.sendMessage(mm)) as { ok: boolean; data?: unknown; error?: string };
    if (!r?.ok) throw new Error(r?.error ?? 'no response');
    return r.data;
  }, m) as Promise<T>;
}

export async function waitFor<T>(fn: () => Promise<T>, pred: (v: T) => boolean, timeoutMs = 60_000, every = 300): Promise<T> {
  const t0 = Date.now();
  let last: T = await fn();
  while (!pred(last)) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`Timed out waiting; last value: ${JSON.stringify(last).slice(0, 500)}`);
    await new Promise((r) => setTimeout(r, every));
    last = await fn();
  }
  return last;
}
