/**
 * Minimal DOM helpers. All text goes through textContent/attributes, never
 * HTML parsing, so bookmark titles, URLs, page metadata and model output are
 * always rendered as inert text.
 */

type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, string | number | boolean | null | undefined | EventListener | ((e: Event) => void)> & {
  class?: string;
  style?: string;
};

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      else if (k === 'class') el.className = String(v);
      // CSSOM assignment is allowed under the strict style-src 'self' CSP; style attributes are not.
      else if (k === 'style') el.style.cssText = String(v);
      else if (v === true) el.setAttribute(k, '');
      else if (k === 'value' && 'value' in el) (el as HTMLInputElement).value = String(v);
      else if (k === 'checked' && 'checked' in el) (el as HTMLInputElement).checked = Boolean(v);
      else el.setAttribute(k, String(v));
    }
  }
  append(el, ...children);
  return el;
}

export function append(el: Node, ...children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function mount(el: Element, ...children: Child[]): void {
  clear(el);
  append(el, ...children);
}

/** Text that may be RTL (Persian/Arabic titles): let the browser pick direction per element. */
export function bidi(text: string, cls = ''): HTMLSpanElement {
  return h('span', { dir: 'auto', class: cls }, text);
}

export function fmtDate(ms: number | undefined): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function fmtDay(ms: number | undefined): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function fmtNum(n: number): string {
  return n.toLocaleString();
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${fmtNum(n)} ${n === 1 ? one : many}`;
}

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number): (...a: A) => void {
  let t: ReturnType<typeof setTimeout> | null = null;
  return (...a: A) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

/** Polite live region for status announcements (screen readers). */
let live: HTMLElement | null = null;
export function announce(text: string): void {
  if (!live) {
    live = h('div', { class: 'sr-only', 'aria-live': 'polite', role: 'status' });
    document.body.appendChild(live);
  }
  live.textContent = '';
  setTimeout(() => (live!.textContent = text), 30);
}

let toastHost: HTMLElement | null = null;
export function toast(text: string, kind: 'info' | 'error' | 'success' = 'info', action?: { label: string; run: () => void }): void {
  if (!toastHost) {
    toastHost = h('div', { class: 'toasts', 'aria-live': 'assertive' });
    document.body.appendChild(toastHost);
  }
  const close = () => t.remove();
  const t = h('div', { class: `toast toast-${kind}`, role: kind === 'error' ? 'alert' : 'status' }, h('span', null, text), action ? h('button', { class: 'btn btn-small', onclick: () => (action.run(), close()) }, action.label) : null, h('button', { class: 'btn-icon', 'aria-label': 'Dismiss', onclick: close }, '×'));
  toastHost.appendChild(t);
  setTimeout(close, kind === 'error' ? 12_000 : 6000);
}

/** Accessible modal dialog using <dialog>. Resolves true when confirmed. */
export function confirmDialog(opts: { title: string; body: Child[]; confirm: string; danger?: boolean; cancel?: string }): Promise<boolean> {
  return new Promise((resolve) => {
    const dlg = h('dialog', { class: 'dialog', 'aria-labelledby': 'dlg-title' });
    const done = (v: boolean) => {
      dlg.close();
      dlg.remove();
      resolve(v);
    };
    append(
      dlg,
      h('h2', { id: 'dlg-title' }, opts.title),
      h('div', { class: 'dialog-body' }, ...opts.body),
      h('div', { class: 'dialog-actions' }, h('button', { class: 'btn', onclick: () => done(false) }, opts.cancel ?? 'Cancel'), h('button', { class: `btn ${opts.danger ? 'btn-danger' : 'btn-primary'}`, onclick: () => done(true) }, opts.confirm)),
    );
    dlg.addEventListener('cancel', (e) => {
      e.preventDefault();
      done(false);
    });
    document.body.appendChild(dlg);
    dlg.showModal();
    (dlg.querySelector('.btn-primary, .btn-danger') as HTMLElement | null)?.focus();
  });
}

export function promptDialog(opts: { title: string; label: string; value?: string; confirm?: string }): Promise<string | null> {
  return new Promise((resolve) => {
    const input = h('input', { type: 'text', class: 'input', value: opts.value ?? '', 'aria-label': opts.label, maxlength: 60 });
    const dlg = h('dialog', { class: 'dialog' });
    const done = (v: string | null) => {
      dlg.close();
      dlg.remove();
      resolve(v);
    };
    const form = h('form', { method: 'dialog', onsubmit: (e: Event) => (e.preventDefault(), done(input.value.trim() || null)) }, h('h2', null, opts.title), h('label', { class: 'field' }, h('span', null, opts.label), input), h('div', { class: 'dialog-actions' }, h('button', { type: 'button', class: 'btn', onclick: () => done(null) }, 'Cancel'), h('button', { type: 'submit', class: 'btn btn-primary' }, opts.confirm ?? 'OK')));
    dlg.appendChild(form);
    dlg.addEventListener('cancel', (e) => (e.preventDefault(), done(null)));
    document.body.appendChild(dlg);
    dlg.showModal();
    input.focus();
    input.select();
  });
}

export function progress(value: number, max: number, label: string): HTMLElement {
  const pct = max > 0 ? Math.round((100 * value) / max) : 0;
  return h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': max, 'aria-valuenow': value, 'aria-label': label }, h('div', { class: 'progress-bar', style: `width:${pct}%` }));
}

export function applyTheme(theme: 'system' | 'light' | 'dark'): void {
  if (theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
}

/** Trigger a download of text content (local only; no network). */
export function downloadText(filename: string, text: string, type = 'application/json'): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h('a', { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function readFileText(file: File, maxBytes: number): Promise<string> {
  if (file.size > maxBytes) return Promise.reject(new Error(`File is larger than ${Math.round(maxBytes / 1048576)} MB`));
  return file.text();
}
