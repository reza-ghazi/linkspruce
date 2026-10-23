/** Paginated, selectable data table (large libraries stay responsive: only one page is in the DOM). */
import { h, mount } from './dom.ts';

export interface Column<T> {
  label: string;
  cell: (row: T) => Node | string;
  cls?: string;
  width?: string;
}

export interface TableOptions<T> {
  columns: Column<T>[];
  rows: T[];
  id: (row: T) => string;
  pageSize: number;
  selectable?: boolean;
  selected?: Set<string>;
  onSelect?: (selected: Set<string>) => void;
  empty: string;
  caption: string;
  page?: number;
  onPage?: (page: number) => void;
}

export function dataTable<T>(o: TableOptions<T>): HTMLElement {
  const wrap = h('div', { class: 'table-wrap' });
  const selected = o.selected ?? new Set<string>();
  let page = o.page ?? 0;
  const pages = Math.max(1, Math.ceil(o.rows.length / o.pageSize));
  const draw = () => {
    page = Math.min(page, pages - 1);
    const slice = o.rows.slice(page * o.pageSize, (page + 1) * o.pageSize);
    if (!o.rows.length) {
      mount(wrap, h('div', { class: 'empty' }, o.empty));
      return;
    }
    const allOnPage = slice.length > 0 && slice.every((r) => selected.has(o.id(r)));
    const head = h(
      'tr',
      null,
      o.selectable
        ? h('th', { scope: 'col', style: 'width:32px' }, h('input', { type: 'checkbox', 'aria-label': 'Select all on this page', checked: allOnPage, onchange: (e: Event) => {
            const on = (e.target as HTMLInputElement).checked;
            for (const r of slice) {
              if (on) selected.add(o.id(r));
              else selected.delete(o.id(r));
            }
            o.onSelect?.(selected);
            draw();
          } }))
        : null,
      ...o.columns.map((c) => h('th', { scope: 'col', style: c.width ? `width:${c.width}` : undefined }, c.label)),
    );
    const body = slice.map((r) => {
      const id = o.id(r);
      return h(
        'tr',
        null,
        o.selectable
          ? h('td', null, h('input', { type: 'checkbox', 'aria-label': 'Select row', checked: selected.has(id), onchange: (e: Event) => {
              if ((e.target as HTMLInputElement).checked) selected.add(id);
              else selected.delete(id);
              o.onSelect?.(selected);
            } }))
          : null,
        ...o.columns.map((c) => h('td', { class: c.cls }, c.cell(r))),
      );
    });
    mount(
      wrap,
      h('table', { class: 'data' }, h('caption', { class: 'sr-only' }, o.caption), h('thead', null, head), h('tbody', null, ...body)),
      pages > 1
        ? h(
            'div',
            { class: 'pager' },
            h('span', { class: 'muted small' }, `${(page * o.pageSize + 1).toLocaleString()}–${Math.min(o.rows.length, (page + 1) * o.pageSize).toLocaleString()} of ${o.rows.length.toLocaleString()}`),
            h('button', { class: 'btn btn-small', disabled: page === 0, onclick: () => ((page = 0), o.onPage?.(page), draw()) }, '« First'),
            h('button', { class: 'btn btn-small', disabled: page === 0, onclick: () => (page--, o.onPage?.(page), draw()) }, '‹ Prev'),
            h('span', { class: 'small' }, `Page ${page + 1} / ${pages}`),
            h('button', { class: 'btn btn-small', disabled: page >= pages - 1, onclick: () => (page++, o.onPage?.(page), draw()) }, 'Next ›'),
            h('button', { class: 'btn btn-small', disabled: page >= pages - 1, onclick: () => ((page = pages - 1), o.onPage?.(page), draw()) }, 'Last »'),
          )
        : null,
    );
  };
  draw();
  return wrap;
}
