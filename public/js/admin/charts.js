// Charts for the Analytics page: a time-series line/area chart with a crosshair tooltip, KPI sparklines, a weekday x hour
// heatmap and a thin segmented bar. SVG drawn at the element's real pixel width (redrawn on resize), labels and
// tooltips as text nodes (never innerHTML). Colours come from CSS tokens (--viz-1, --viz-2 in admin.css).
import { el } from '../common.js';
import { num, compact } from './ui.js';

const NS = 'http://www.w3.org/2000/svg';
function svg(tag, attrs = {}) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) node.setAttribute(k, String(v));
  return node;
}

// ---------- time labels (the viewer's own time zone; the server bucketed with it) ----------
const hourFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
const wdFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
const fullFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const fullTimeFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** Tooltip / table label for a bucket starting at `t`. unit: 'slot' (5 min) | 'hour' | 'day'. */
export function bucketLabel(t, unit) {
  if (unit === 'day') return fullFmt.format(t);
  if (unit === 'hour') return `${fullFmt.format(t)}, ${hourFmt.format(t)}–${hourFmt.format(t + 3_600_000)}`;
  return `${fullTimeFmt.format(t)}`;
}

/** Up to ~7 tick positions with short labels, on round boundaries. */
function ticks(points, unit) {
  const n = points.length;
  if (!n) return [];
  const out = [];
  if (unit === 'day') {
    const every = Math.max(1, Math.ceil(n / 7));
    for (let i = n - 1; i >= 0; i -= every) out.unshift([i, dayFmt.format(points[i].t)]);
    return out;
  }
  const spanH = (points[n - 1].t - points[0].t) / 3_600_000;
  if (spanH > 48) { // a week of hours: label each midnight with the weekday
    points.forEach((p, i) => { if (new Date(p.t).getHours() === 0) out.push([i, `${wdFmt.format(p.t)} ${new Date(p.t).getDate()}`]); });
    return out;
  }
  const stepH = spanH > 12 ? 4 : 2;
  points.forEach((p, i) => {
    const d = new Date(p.t);
    if (d.getMinutes() === 0 && d.getHours() % stepH === 0) out.push([i, hourFmt.format(p.t)]);
  });
  return out;
}

/** Round gridline values covering `max` (counts and minutes: whole numbers). */
function yScale(max, lines = 4) {
  if (!(max > 0)) return { top: lines, step: 1 };
  const raw = max / lines;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(1, [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw));
  return { top: Math.ceil(max / step) * step, step };
}

/** Redraw `draw(width)` whenever the element's width changes. */
function onWidth(node, draw) {
  let w = 0;
  const ro = new ResizeObserver(([entry]) => {
    const next = Math.round(entry.contentRect.width);
    if (next && next !== w) { w = next; draw(w); }
  });
  ro.observe(node);
}

// ---------- line / area chart ----------
/**
 * points: [{ t, [key]: number }], series: [{ key, label, color }] (one or two), unit: 'slot' | 'hour' | 'day'.
 * One series gets an area wash; a legend shows for two. Hover / arrow keys move a crosshair that reads every series.
 */
export function lineChart(points, series, { unit = 'hour', height = 240, format = num, name = 'Chart' } = {}) {
  const wrap = el('div', { class: 'tchart' });
  const legend = series.length > 1
    ? el('div', { class: 'legend' }, series.map((s) => el('span', {}, el('i', { class: 'key-line', style: `background:${s.color}` }), s.label)))
    : null;
  const box = el('div', { class: 'tchart-box', style: `height:${height}px` });
  const tip = el('div', { class: 'chart-tip', hidden: true });
  box.append(tip);
  const table = el('details', { class: 'chart-table' }, el('summary', {}, 'Show as table'),
    el('div', { class: 'table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, el('th', {}, unit === 'day' ? 'Day' : 'Time'), series.map((s) => el('th', { class: 'num' }, s.label)))),
      el('tbody', {}, [...points].reverse().map((p) => el('tr', {}, el('td', {}, bucketLabel(p.t, unit)),
        series.map((s) => el('td', { class: 'num' }, format(p[s.key])))))))));
  if (legend) wrap.append(legend);
  wrap.append(box, table);

  const M = { l: 44, r: 12, t: 10, b: 26 };
  let sel = null; // index under the crosshair
  let geom = null;

  function draw(width) {
    box.querySelector('svg')?.remove();
    const W = width;
    const H = height;
    const iw = Math.max(10, W - M.l - M.r);
    const ih = H - M.t - M.b;
    const max = Math.max(0, ...points.flatMap((p) => series.map((s) => p[s.key] || 0)));
    const { top, step } = yScale(max);
    const n = points.length;
    const x = (i) => M.l + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
    const y = (v) => M.t + ih - ((v || 0) / top) * ih;
    geom = { x, y, n, iw };
    const root = svg('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': name, tabindex: 0, class: 'tchart-svg' });

    for (let v = 0; v <= top + 1e-9; v += step) {
      root.append(svg('line', { x1: M.l, x2: W - M.r, y1: y(v), y2: y(v), class: v === 0 ? 'axis' : 'grid' }));
      const label = svg('text', { x: M.l - 8, y: y(v), class: 'ytick', 'text-anchor': 'end', 'dominant-baseline': 'middle' });
      label.textContent = compact(Math.round(v * 100) / 100);
      root.append(label);
    }
    let lastX = -Infinity;
    for (const [i, text] of ticks(points, unit)) {
      if (x(i) - lastX < 72) continue; // labels never collide
      lastX = x(i);
      const tx = svg('text', { x: x(i), y: H - 6, class: 'xtick', 'text-anchor': i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle' });
      tx.textContent = text;
      root.append(tx);
    }

    series.forEach((s, si) => {
      const pts = points.map((p, i) => [x(i), y(p[s.key])]);
      const d = pts.map(([px, py], i) => `${i ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`).join('');
      if (series.length === 1 && pts.length) {
        root.append(svg('path', { d: `${d}L${pts.at(-1)[0].toFixed(1)},${y(0)}L${pts[0][0].toFixed(1)},${y(0)}Z`, class: 'area', style: `fill:${s.color}` }));
      }
      root.append(svg('path', { d, class: 'line', style: `stroke:${s.color}` }));
      // End dot on the latest value of the main series.
      if (si === 0 && pts.length) root.append(svg('circle', { cx: pts.at(-1)[0], cy: pts.at(-1)[1], r: 4, class: 'end-dot', style: `fill:${s.color}` }));
    });

    const cross = svg('g', { class: 'cross', visibility: 'hidden' });
    cross.append(svg('line', { y1: M.t, y2: M.t + ih, class: 'cross-line' }));
    series.forEach((s) => cross.append(svg('circle', { r: 4.5, class: 'cross-dot', style: `fill:${s.color}` })));
    root.append(cross);
    const hit = svg('rect', { x: M.l - 6, y: 0, width: iw + 12, height: H, fill: 'transparent' });
    root.append(hit);

    const pick = (clientX) => {
      const r = root.getBoundingClientRect();
      const px = clientX - r.left - M.l;
      return Math.min(n - 1, Math.max(0, Math.round((px / iw) * (n - 1))));
    };
    hit.addEventListener('pointermove', (e) => show(pick(e.clientX)));
    hit.addEventListener('pointerleave', hide);
    root.addEventListener('blur', hide);
    root.addEventListener('focus', () => show(sel ?? n - 1));
    root.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        show(Math.min(n - 1, Math.max(0, (sel ?? n - 1) + (e.key === 'ArrowRight' ? 1 : -1))));
      } else if (e.key === 'Home') show(0);
      else if (e.key === 'End') show(n - 1);
    });

    function show(i) {
      if (!n) return;
      sel = i;
      const p = points[i];
      const cx = x(i);
      cross.setAttribute('visibility', 'visible');
      cross.querySelector('line').setAttribute('x1', cx);
      cross.querySelector('line').setAttribute('x2', cx);
      [...cross.querySelectorAll('circle')].forEach((c, k) => { c.setAttribute('cx', cx); c.setAttribute('cy', y(p[series[k].key])); });
      tip.replaceChildren(
        el('span', { class: 'tip-when' }, bucketLabel(p.t, unit)),
        ...series.map((s) => el('span', { class: 'tip-row' }, el('i', { class: 'key-line', style: `background:${s.color}` }),
          el('b', {}, format(p[s.key] ?? 0)), s.label)));
      tip.hidden = false;
      const half = tip.offsetWidth / 2;
      tip.style.left = `${Math.min(Math.max(cx, half), W - half)}px`;
      tip.style.top = `${Math.min(...series.map((s) => y(p[s.key])))}px`;
    }
    function hide() {
      sel = null;
      cross.setAttribute('visibility', 'hidden');
      tip.hidden = true;
    }
    box.prepend(root);
  }
  onWidth(box, draw);
  return wrap;
}

// ---------- sparkline (inside a KPI tile; the main chart and its table carry the values) ----------
export function sparkline(values, { color = 'var(--viz-1)', height = 34 } = {}) {
  const box = el('div', { class: 'spark', 'aria-hidden': 'true', style: `height:${height}px` });
  onWidth(box, (W) => {
    box.replaceChildren();
    const n = values.length;
    if (n < 2) return;
    const max = Math.max(1, ...values);
    const x = (i) => 2 + (i / (n - 1)) * (W - 6);
    const y = (v) => height - 3 - ((v || 0) / max) * (height - 8);
    const d = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
    const root = svg('svg', { width: W, height, viewBox: `0 0 ${W} ${height}` });
    root.append(svg('path', { d: `${d}L${x(n - 1)},${height}L${x(0)},${height}Z`, class: 'area', style: `fill:${color}` }));
    root.append(svg('path', { d, class: 'line thin', style: `stroke:${color}` }));
    root.append(svg('circle', { cx: x(n - 1), cy: y(values[n - 1]), r: 3, class: 'end-dot', style: `fill:${color}` }));
    box.append(root);
  });
  return box;
}

// ---------- heatmap ----------
const DAYS = [1, 2, 3, 4, 5, 6, 0]; // Monday first; matrix rows are getUTCDay() order (Sunday = 0)
const dayName = (d) => new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(new Date(Date.UTC(2024, 0, 7 + d, 12)));
const hourName = (h) => hourFmt.format(new Date(2024, 0, 1, h));

/** matrix[weekday 0=Sun][hour] = average people online (null: that hour isn't in the range). */
export function heatmap(matrix, { format = (v) => v.toFixed(1), label = 'avg. online' } = {}) {
  const max = Math.max(0, ...matrix.flat().filter((v) => v != null));
  const level = (v) => (v == null ? 'na' : v <= 0 || !max ? 0 : Math.min(5, Math.ceil((v / max) * 5)));
  const tip = el('div', { class: 'chart-tip', hidden: true });
  const grid = el('div', { class: 'heat', role: 'grid', 'aria-label': `People online by weekday and hour (${label})` });
  grid.append(el('span'));
  for (let h = 0; h < 24; h++) grid.append(el('span', { class: 'heat-h' }, h % 3 === 0 ? String(h).padStart(2, '0') : ''));
  const wrap = el('div', { class: 'heat-wrap' });
  for (const d of DAYS) {
    grid.append(el('span', { class: 'heat-d' }, dayName(d)));
    for (let h = 0; h < 24; h++) {
      const v = matrix[d]?.[h] ?? null;
      const text = `${dayName(d)} ${hourName(h)}: ${v == null ? 'not in range' : `${format(v)} ${label}`}`;
      const cell = el('span', { class: `heat-c l${level(v)}`, tabindex: '0', role: 'gridcell', 'aria-label': text });
      const show = () => {
        tip.replaceChildren(el('b', {}, v == null ? '–' : format(v)), `${label} · ${dayName(d)} ${hourName(h)}`);
        tip.hidden = false;
        const b = wrap.getBoundingClientRect();
        const c = cell.getBoundingClientRect();
        const half = tip.offsetWidth / 2;
        tip.style.left = `${Math.min(Math.max(c.left + c.width / 2 - b.left, half), b.width - half)}px`;
        tip.style.top = `${c.top - b.top}px`;
      };
      cell.addEventListener('pointerenter', show);
      cell.addEventListener('focus', show);
      cell.addEventListener('pointerleave', () => { tip.hidden = true; });
      cell.addEventListener('blur', () => { tip.hidden = true; });
      grid.append(cell);
    }
  }
  const scale = el('div', { class: 'heat-scale', 'aria-hidden': 'true' }, 'Less',
    [0, 1, 2, 3, 4, 5].map((l) => el('i', { class: `heat-c l${l}` })), 'More');
  const table = el('details', { class: 'chart-table' }, el('summary', {}, 'Show as table'),
    el('div', { class: 'table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, el('th', {}, 'Hour'), DAYS.map((d) => el('th', { class: 'num' }, dayName(d))))),
      el('tbody', {}, Array.from({ length: 24 }, (_, h) => el('tr', {}, el('td', {}, hourName(h)),
        DAYS.map((d) => el('td', { class: 'num' }, matrix[d]?.[h] == null ? '–' : format(matrix[d][h])))))))));
  wrap.append(el('div', { class: 'heat-scroll' }, grid), tip, scale, table);
  return wrap;
}

// ---------- segmented bar: one whole split into parts ----------
/** parts: [{ label, value, color }]. Thin bar plus a legend with each part's count and share. */
export function segBar(parts) {
  const total = parts.reduce((s, p) => s + p.value, 0);
  const shown = parts.filter((p) => p.value > 0);
  return el('div', { class: 'segbar-wrap' },
    el('div', { class: 'segbar', role: 'img', 'aria-label': parts.map((p) => `${p.label}: ${num(p.value)}`).join(', ') },
      total ? shown.map((p) => el('i', { style: `flex:${p.value} 1 0;background:${p.color}`, title: `${p.label}: ${num(p.value)}` })) : el('i', { class: 'none' })),
    el('ul', { class: 'seg-legend' }, parts.map((p) => el('li', {},
      el('i', { style: `background:${p.color}` }), el('span', {}, p.label),
      el('b', {}, num(p.value)), el('small', {}, total ? `${Math.round((p.value / total) * 100)}%` : '–')))));
}
