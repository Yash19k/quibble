// Building blocks shared by the admin console's pages: formatting, page heads, KPI tiles, tables with paging,
// a column chart, bar lists and themed dialogs. Everything renders with textContent (common.js el), never innerHTML.
import { el, clear, toast, withPending, copyText } from '../common.js';
import { aicon } from './icons.js';

// ---------- formatting ----------
const numberFormat = new Intl.NumberFormat();
export const num = (n) => (n == null || Number.isNaN(n) ? '–' : numberFormat.format(n));
const compactFormat = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
export const compact = (n) => (n >= 10_000 ? compactFormat.format(n) : num(n));

const dateTimeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
export const dateTime = (iso) => (iso && Number.isFinite(Date.parse(iso)) ? dateTimeFormat.format(new Date(iso)) : '–');
const dayFormat = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
const longDayFormat = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
/** "YYYY-MM-DD" (a calendar day) -> "21 Nov". Parsed at local noon so no time zone moves it to another day. */
export const shortDay = (day) => dayFormat.format(new Date(`${day}T12:00:00`));
export const longDay = (day) => longDayFormat.format(new Date(`${day}T12:00:00`));

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
/** "3 minutes ago", "in 2 hours", "just now". */
export function ago(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (!iso || !Number.isFinite(t)) return 'never';
  const s = Math.round((t - now) / 1000);
  const abs = Math.abs(s);
  if (abs < 45) return 'just now';
  if (abs < 3600) return relative.format(Math.round(s / 60), 'minute');
  if (abs < 86_400) return relative.format(Math.round(s / 3600), 'hour');
  if (abs < 86_400 * 30) return relative.format(Math.round(s / 86_400), 'day');
  if (abs < 86_400 * 365) return relative.format(Math.round(s / (86_400 * 30)), 'month');
  return relative.format(Math.round(s / (86_400 * 365)), 'year');
}
/** A relative time with the exact date on hover. */
export const when = (iso) => (iso ? el('time', { datetime: iso, title: dateTime(iso), class: 'nowrap' }, ago(iso)) : el('span', { class: 'muted' }, 'never'));

export function bytes(n) {
  if (n == null) return '–';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function duration(ms) {
  if (ms == null || ms < 0) return '–';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${s % 60} s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

export const plural = (n, one, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;

// ---------- links ----------
export const hrefs = {
  user: (id) => `#/users/${encodeURIComponent(id)}`,
  game: (code) => `#/games/${encodeURIComponent(code)}`,
  quiz: (id) => `#/quizzes/${encodeURIComponent(id)}`,
};
export const link = (href, text, cls = 'cell-main') => el('a', { href, class: cls }, text);

// ---------- page chrome ----------
export function pageHead(title, sub, ...actions) {
  return el('div', { class: 'page-head' },
    el('div', {}, el('h2', {}, title), sub ? el('p', {}, sub) : null),
    actions.filter(Boolean).length ? el('div', { class: 'page-actions' }, ...actions.filter(Boolean)) : null);
}

export const back = (href, text) => el('a', { class: 'back', href }, aicon('arrowLeft', { size: 15 }), text);

/** A button with an icon. `cls` adds classes (ghost, danger, small). */
export const button = (label, iconName, onclick, cls = '') =>
  el('button', { type: 'button', class: `${cls} with-icon`.trim(), onclick }, iconName ? aicon(iconName, { size: 16 }) : null, label);

/**
 * Click handler with a busy button and errors as a toast. `fn()` (no parameter): the button shows `busyLabel` for the
 * whole run. `fn(busy)`: it asks first (a dialog) and wraps only the real work, `await busy(() => api(...))`, so the
 * button doesn't say "Deleting…" while the admin is still deciding.
 */
export const act = (busyLabel, fn) => async (e) => {
  const btn = e?.currentTarget;
  if (btn?.getAttribute('aria-busy') === 'true') return;
  try {
    if (fn.length === 0) await withPending(btn, busyLabel, fn);
    else await fn((work) => withPending(btn, busyLabel, work));
  } catch (err) {
    toast(err.message);
  }
};

/** Replace a node's children, skipping null / false (Node.append would print them as text). */
export function fill(node, ...kids) {
  node.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));
  return node;
}

export function loading(node) {
  clear(node).append(el('div', { class: 'spinner', role: 'status', 'aria-label': 'Loading' }));
  return node;
}

/** A load failed: say why and offer a retry instead of leaving a blank page. */
export function failed(node, err, retry) {
  clear(node).append(el('div', { class: 'card' },
    el('div', { class: 'notice bad' }, aicon('alert'), el('span', {}, err.message || 'Something went wrong.')),
    retry ? el('div', { style: 'margin-top:14px' }, button('Try again', 'refresh', retry, 'ghost')) : null));
  return node;
}

export const empty = (iconName, title, text) =>
  el('div', { class: 'empty' }, aicon(iconName, { size: 28 }), el('b', {}, title), text ? el('span', {}, text) : null);

export function copyButton(text, label = 'Copy') {
  const btn = el('button', { type: 'button', class: 'ghost small icon-btn copy-btn', title: label, 'aria-label': label }, aicon('copy', { size: 14 }));
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    toast((await copyText(text)) ? 'Copied' : 'Could not copy');
  });
  return btn;
}

// ---------- pills ----------
const STATE_LABELS = { lobby: 'Lobby', question: 'Live', reveal: 'Live', ended: 'Finished', cancelled: 'Cancelled', expired: 'Expired' };
export const statePill = (state) => el('span', { class: `pill st-${state}` }, STATE_LABELS[state] ?? state);
export const rolePill = (role) => el('span', { class: `pill${role === 'admin' ? ' admin' : ''}` }, role);
export const pill = (text, cls = '') => el('span', { class: `pill ${cls}`.trim() }, text);
export const onlineDot = (on, title = on ? 'Online now' : 'Offline') => el('span', { class: `dot${on ? ' on' : ''}`, title, 'aria-label': title, role: 'img' });

/** A rank column (gold / silver / bronze badges for the top three, as on the player leaderboards). */
export const rankColumn = (rankOf) => ({
  label: '#', headCls: 'medal', cls: (r) => `medal r${rankOf(r)}`, cell: (r) => el('span', { class: 'rk' }, rankOf(r)),
});

// ---------- KPI tiles ----------
/**
 * { label, value, icon, sub, delta: { now, prev, period } }. The delta says how `now` compares with the previous period
 * (up = good for every metric shown).
 */
export function kpi({ label, value, icon: iconName, sub, delta }) {
  let deltaEl = null;
  if (delta && delta.prev != null) {
    const diff = delta.now - delta.prev;
    const cls = diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat';
    const pct = delta.prev > 0 ? ` (${diff > 0 ? '+' : ''}${Math.round((diff / delta.prev) * 100)}%)` : '';
    deltaEl = el('span', { class: 'kpi-sub' },
      el('span', { class: `delta ${cls}` }, diff ? aicon(diff > 0 ? 'arrowUp' : 'arrowDown', { size: 13 }) : null, `${diff > 0 ? '+' : ''}${num(diff)}${pct}`),
      ` vs previous ${delta.period}`);
  }
  return el('div', { class: 'kpi' },
    el('span', { class: 'kpi-label' }, iconName ? aicon(iconName, { size: 14 }) : null, label),
    el('span', { class: 'kpi-value' }, typeof value === 'number' ? compact(value) : value),
    deltaEl,
    sub ? el('span', { class: 'kpi-sub' }, sub) : null);
}

// ---------- tables ----------
/**
 * columns: [{ label, num, cls, cell(row) -> node | string }]
 * opts.href(row): clicking (or Enter on) a row opens it; clicks on buttons / links / checkboxes inside are left alone.
 * opts.select: { has(row), toggle(row, on), all(on), allChecked } adds a checkbox column.
 */
export function dataTable(columns, rows, { href, select, emptyNode } = {}) {
  if (!rows.length) return emptyNode ?? empty('search', 'Nothing here', 'Nothing matches these filters.');
  // `cls` may be a function of the row (e.g. a medal class per rank); the header then uses `headCls`.
  const clsOf = (c, row) => `${c.num ? 'num' : ''} ${(typeof c.cls === 'function' ? (row ? c.cls(row) : c.headCls) : c.cls) || ''}`.trim();
  const head = columns.map((c) => el('th', { class: clsOf(c, null) }, c.label));
  if (select) {
    const all = el('input', { type: 'checkbox', 'aria-label': 'Select all on this page', checked: select.allChecked });
    all.addEventListener('change', () => select.all(all.checked));
    head.unshift(el('th', { class: 'sel' }, all));
  }
  const body = rows.map((row) => {
    const cells = columns.map((c) => {
      const v = c.cell(row);
      return el('td', { class: clsOf(c, row) }, v ?? '–');
    });
    if (select) {
      const box = el('input', { type: 'checkbox', 'aria-label': 'Select row', checked: select.has(row) });
      box.addEventListener('change', () => select.toggle(row, box.checked));
      cells.unshift(el('td', { class: 'sel' }, box));
    }
    const tr = el('tr', {}, cells);
    if (href) {
      tr.classList.add('click');
      tr.tabIndex = 0;
      const open = (e) => {
        if (e.target.closest('button, a, input, select, label')) return;
        location.hash = href(row);
      };
      tr.addEventListener('click', open);
      tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(e); });
    }
    return tr;
  });
  return el('div', { class: 'table-wrap' }, el('table', { class: 'data' }, el('thead', {}, el('tr', {}, head)), el('tbody', {}, body)));
}

/** "26–50 of 312" with previous / next buttons. `onPage(newPage)`. */
export function pager(total, page, size, onPage) {
  const pages = Math.max(1, Math.ceil(total / size));
  const from = total ? page * size + 1 : 0;
  const to = Math.min(total, (page + 1) * size);
  const prev = el('button', { type: 'button', class: 'ghost small icon-btn', 'aria-label': 'Previous page', disabled: page <= 0, onclick: () => onPage(page - 1) }, aicon('chevronLeft', { size: 16 }));
  const next = el('button', { type: 'button', class: 'ghost small icon-btn', 'aria-label': 'Next page', disabled: page >= pages - 1, onclick: () => onPage(page + 1) }, aicon('chevronRight', { size: 16 }));
  return el('div', { class: 'pager' }, el('span', {}, `${num(from)}–${num(to)} of ${num(total)}`),
    pages > 1 ? el('div', { class: 'row' }, prev, el('span', {}, `Page ${page + 1} of ${pages}`), next) : null);
}

/** A search box that calls `onSearch(text)` 200 ms after typing stops. */
export function searchBox(value, placeholder, onSearch) {
  const input = el('input', { type: 'search', value, placeholder, 'aria-label': placeholder });
  let t;
  input.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => onSearch(input.value.trim()), 200);
  });
  return el('div', { class: 'search' }, aicon('search', { size: 16 }), input);
}

/** A <select>: options = [[value, label], ...]. */
export function select(options, value, onChange, label) {
  const s = el('select', { 'aria-label': label }, options.map(([v, text]) => el('option', { value: v, selected: v === value }, text)));
  s.addEventListener('change', () => onChange(s.value));
  return s;
}

/** Segmented buttons (style.css .tabs.seg): options = [[value, label], ...]. */
export function segmented(options, value, onChange, label) {
  return el('div', { class: 'tabs seg', role: 'group', 'aria-label': label },
    options.map(([v, text]) => el('button', {
      type: 'button', class: v === value ? 'active' : '', 'aria-pressed': String(v === value), onclick: () => onChange(v),
    }, text)));
}

// ---------- charts ----------
/** A round step so ~4 gridlines cover `max` (counts: never below 1). */
export function niceScale(max, lines = 4) {
  if (!(max > 0)) return { top: lines, step: 1 };
  const raw = max / lines;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(1, [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw)); // whole numbers only: counts
  return { top: Math.ceil(max / step) * step, step };
}

/**
 * One series of daily counts as columns: points = [{ day: 'YYYY-MM-DD', value }]. Hover or focus a column for its
 * value; "Show as table" lists every day.
 */
export function columnChart(points, { name, format = num } = {}) {
  const max = Math.max(0, ...points.map((p) => p.value));
  const { top, step } = niceScale(max);
  const plot = el('div', { class: 'plot' });
  for (let v = 0; v <= top; v += step) {
    plot.append(el('div', { class: `grid-line${v === 0 ? ' base' : ''}`, style: `bottom:${(v / top) * 100}%` }, el('span', {}, compact(v))));
  }
  const tip = el('div', { class: 'chart-tip', hidden: true });
  const wrap = el('div', { class: 'chart' });
  const show = (col, p) => {
    tip.replaceChildren(el('b', {}, format(p.value)), `${name} · ${longDay(p.day)}`);
    tip.hidden = false;
    const box = wrap.getBoundingClientRect();
    const c = col.getBoundingClientRect();
    const bar = col.firstChild.getBoundingClientRect();
    const half = tip.offsetWidth / 2; // keep the whole tooltip inside the card
    const x = Math.min(Math.max(c.left + c.width / 2 - box.left, half), box.width - half);
    tip.style.left = `${x}px`;
    tip.style.top = `${Math.min(bar.top, c.bottom - 4) - box.top}px`;
  };
  const hide = () => { tip.hidden = true; };
  const cols = el('div', { class: 'cols' }, points.map((p) => {
    const col = el('div', { class: 'col', tabindex: '0', role: 'img', 'aria-label': `${longDay(p.day)}: ${format(p.value)} ${name}` },
      el('i', { class: p.value ? '' : 'zero', style: `height:${(p.value / top) * 100}%` }));
    col.addEventListener('pointerenter', () => show(col, p));
    col.addEventListener('focus', () => show(col, p));
    col.addEventListener('pointerleave', hide);
    col.addEventListener('blur', hide);
    return col;
  }));
  plot.append(cols);
  const mid = points[Math.floor((points.length - 1) / 2)];
  const axis = el('div', { class: 'x-axis', 'aria-hidden': 'true' },
    el('span', {}, points.length ? shortDay(points[0].day) : ''),
    points.length > 2 ? el('span', {}, shortDay(mid.day)) : null,
    el('span', {}, points.length > 1 ? shortDay(points.at(-1).day) : ''));
  const table = el('details', { class: 'chart-table' }, el('summary', {}, 'Show as table'),
    el('div', { class: 'table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, el('th', {}, 'Day'), el('th', { class: 'num' }, name))),
      el('tbody', {}, [...points].reverse().map((p) => el('tr', {}, el('td', {}, longDay(p.day)), el('td', { class: 'num' }, format(p.value))))))));
  wrap.append(plot, axis, tip, table);
  return wrap;
}

/** Horizontal bars: items = [{ label (node | text), value, href? }], longest first. */
export function barList(items) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return el('ul', { class: 'barlist' }, items.map((i) => el('li', {},
    el('span', { class: 'bl-label', title: typeof i.label === 'string' ? i.label : null }, i.label),
    el('span', { class: 'bl-track', 'aria-hidden': 'true' }, el('i', { style: `width:${(i.value / max) * 100}%` })),
    el('span', { class: 'bl-value' }, num(i.value)))));
}

// ---------- dialogs (themed, like confirmDialog in common.js) ----------
let dialogSeq = 0;

/**
 * A popup form. fields: [{ name, label, type: 'text' | 'textarea' | 'select' | 'password', value, placeholder,
 * maxlength, options: [[value, label]], hint }]. `validate(values)` returns an error message or null.
 * Resolves the values, or null when cancelled.
 */
export function formDialog({ title, message = '', fields = [], confirmLabel = 'Save', danger = false, wide = false, validate } = {}) {
  return new Promise((resolve) => {
    const id = `adlg${++dialogSeq}`;
    const inputs = {};
    const rows = fields.map((f, i) => {
      const fid = `${id}-${i}`;
      let input;
      if (f.type === 'textarea') input = el('textarea', { id: fid, rows: f.rows || 4, maxlength: f.maxlength, placeholder: f.placeholder }, f.value ?? '');
      else if (f.type === 'select') input = el('select', { id: fid }, f.options.map(([v, t]) => el('option', { value: v, selected: v === f.value }, t)));
      else input = el('input', { id: fid, type: f.type || 'text', value: f.value ?? '', maxlength: f.maxlength, placeholder: f.placeholder, autocomplete: 'off', spellcheck: f.spellcheck ?? null });
      inputs[f.name] = input;
      return [el('label', { for: fid }, f.label), input, f.hint ? el('p', { class: 'hint' }, f.hint) : null];
    });
    const error = el('div', { class: 'error', role: 'alert' });
    const cancel = el('button', { type: 'button', class: 'ghost', onclick: () => dlg.close('cancel') }, 'Cancel');
    const ok = el('button', { type: 'submit', class: danger ? 'danger' : '' }, confirmLabel);
    const values = () => Object.fromEntries(Object.entries(inputs).map(([k, input]) => [k, input.value.trim()]));
    const form = el('form', { method: 'dialog' },
      el('h3', { id: `${id}-t` }, title),
      message ? el('p', { class: 'muted' }, message) : null,
      ...rows.flat(),
      error,
      el('div', { class: 'modal-actions' }, cancel, ok));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const problem = validate?.(values());
      if (problem) {
        error.textContent = problem;
        return;
      }
      dlg.close('ok');
    });
    const dlg = el('dialog', { class: `modal${wide ? ' wide' : ''}`, 'aria-labelledby': `${id}-t` }, form);
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close('cancel'); });
    dlg.addEventListener('close', () => {
      resolve(dlg.returnValue === 'ok' ? values() : null);
      dlg.remove();
    }, { once: true });
    document.body.append(dlg);
    dlg.showModal();
    (Object.values(inputs)[0] ?? (danger ? cancel : ok)).focus();
  });
}

/** Shows a one-time secret (a temporary password) with a copy button. */
export function secretDialog({ title, message, secret }) {
  return new Promise((resolve) => {
    const input = el('input', { type: 'text', value: secret, readonly: true, 'aria-label': title });
    const copy = el('button', { type: 'button', class: 'ghost with-icon' }, aicon('copy', { size: 16 }), 'Copy');
    copy.addEventListener('click', async () => toast((await copyText(secret, input)) ? 'Copied' : 'Select it and copy by hand'));
    const done = el('button', { type: 'button', onclick: () => dlg.close() }, 'Done');
    const dlg = el('dialog', { class: 'modal' },
      el('h3', {}, title),
      el('p', { class: 'muted' }, message),
      el('div', { class: 'secret' }, input, copy),
      el('div', { class: 'modal-actions' }, done));
    dlg.addEventListener('close', () => { resolve(); dlg.remove(); }, { once: true });
    document.body.append(dlg);
    dlg.showModal();
    input.select();
  });
}

/** "Type the name to confirm" for things that can't be undone. Resolves true when confirmed. */
export async function typeToConfirm({ title, message, expected, confirmLabel = 'Delete' }) {
  const v = await formDialog({
    title, message, confirmLabel, danger: true,
    fields: [{ name: 'typed', label: `Type ${expected} to confirm`, placeholder: expected, spellcheck: 'false' }],
    validate: ({ typed }) => (typed === expected ? null : `Type ${expected} exactly.`),
  });
  return !!v;
}

/** Save `text` as a file. */
export function download(filename, text, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = el('a', { href: url, download: filename, hidden: true });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
