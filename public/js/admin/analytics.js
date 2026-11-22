// Analytics: who is on the site right now (refreshed every 10 s) and how it has been used over a date range: visitors,
// sessions, engaged time, peak concurrency, when people play (weekday x hour), pages, devices, the most active players,
// games and the latest sessions. Data: public/js/presence.js heartbeats -> lib/analytics.js.
import { api, el } from '../common.js';
import { aicon } from './icons.js';
import {
  pageHead, segmented, button, loading, failed, num, compact, plural, hrefs, link, dataTable, empty, barList, fill,
  rankColumn, statePill, ago,
} from './ui.js';
import { lineChart, sparkline, heatmap, segBar, bucketLabel } from './charts.js';

const RANGES = [['24h', '24 hours'], ['7d', '7 days'], ['30d', '30 days'], ['90d', '90 days']];
const PERIOD = { '24h': 'previous 24 h', '7d': 'previous 7 days', '30d': 'previous 30 days', '90d': 'previous 90 days' };
const LIVE_MS = 10_000;
const REPORT_MS = 60_000;

const V1 = 'var(--viz-1)';
const V2 = 'var(--viz-2)';
const V3 = 'var(--viz-3)';

const PAGE_LABELS = { home: 'Landing page', play: 'Lobby & menus', game: 'In a game', how: 'How it works', admin: 'Admin console' };
const PAGE_ICONS = { home: 'home', play: 'dashboard', game: 'gamepad', how: 'infoCircle', admin: 'shield' };
const DEVICE_LABELS = { desktop: 'Desktop', mobile: 'Mobile', tablet: 'Tablet' };
const DEVICE_ICONS = { desktop: 'monitor', mobile: 'phone', tablet: 'tablet' };

const METRICS = [
  { id: 'traffic', label: 'Visitors', series: [{ key: 'visitors', label: 'Visitors', color: V1 }, { key: 'sessions', label: 'Sessions', color: V2 }] },
  { id: 'engaged', label: 'Engaged time', series: [{ key: 'activeMin', label: 'Engaged minutes', color: V1 }] },
  { id: 'players', label: 'Signed-in', series: [{ key: 'signedIn', label: 'Signed-in players', color: V1 }] },
  { id: 'games', label: 'Games', series: [{ key: 'plays', label: 'Plays', color: V1 }, { key: 'games', label: 'Games', color: V2 }] },
  { id: 'signups', label: 'Sign-ups', series: [{ key: 'signups', label: 'Sign-ups', color: V1 }] },
];

let range = '7d';
let metric = 'traffic';

/** "1 h 12 min", "4 min 10 s", "35 s". */
export function span(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min${s % 60 && m < 10 ? ` ${s % 60} s` : ''}`;
  const h = Math.floor(m / 60);
  return `${h} h${m % 60 ? ` ${m % 60} min` : ''}`;
}

const initials = (name) => (name || '?').replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '?';
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

export async function render(body, args, ctx) {
  const tz = -new Date().getTimezoneOffset();
  let report = null;
  let liveData = null;
  let liveTrail = []; // [{ t, value }] online counts seen while this page is open
  const slots = { live: el('div'), report: el('div') };
  const updated = el('span', { class: 'updated' });

  async function loadReport({ quiet = false } = {}) {
    if (!report) loading(slots.report);
    else if (!quiet) slots.report.classList.add('refetching');
    try {
      const next = await api(`/api/admin/analytics?range=${range}&tz=${tz}`);
      if (!ctx.isCurrent()) return;
      report = next;
      drawReport();
    } catch (err) {
      if (ctx.isCurrent() && !report) failed(slots.report, err, () => loadReport());
    } finally {
      slots.report.classList.remove('refetching');
    }
  }

  async function loadLive() {
    try {
      const next = await api('/api/admin/analytics/live');
      if (!ctx.isCurrent()) return;
      liveData = next;
      liveTrail.push({ t: next.generatedAt, value: next.counts.total });
      if (liveTrail.length > 360) liveTrail = liveTrail.slice(-360);
      ctx.setCount('live', next.games.live);
      ctx.setCount('analytics', next.counts.total);
      drawLive();
      updated.textContent = `Live · updated ${timeFmt.format(next.generatedAt)}`;
    } catch (err) {
      if (ctx.isCurrent() && !liveData) failed(slots.live, err, loadLive);
    }
  }

  function setRange(v) {
    range = v;
    head.replaceWith(head = header());
    loadReport();
  }

  function header() {
    return pageHead('Analytics', null,
      updated,
      segmented(RANGES, range, setRange, 'Date range'),
      button('Refresh', 'refresh', () => { loadLive(); loadReport(); }, 'ghost'));
  }
  let head = header();
  fill(body, head, slots.live, slots.report);
  loading(slots.live);

  // ---------- live ----------
  function drawLive() {
    const d = liveData;
    // The last two hours in 5-minute steps, then every poll since the page opened.
    const trail = [...d.recent.slice(0, -1), ...liveTrail.filter((p) => p.t > d.recent.at(-1).t - 1)];
    fill(slots.live, el('section', { class: 'card realtime', 'aria-label': 'Right now' },
      el('div', { class: 'rt-head' },
        el('h3', { class: 'with-icon' }, el('span', { class: `dot${d.counts.total ? ' on' : ''}` }), 'Right now'),
        el('span', { class: 'muted small-mono' }, `Online = active in the last ${d.onlineWindowSec} s · refreshes every ${LIVE_MS / 1000} s`)),
      el('div', { class: 'rt-grid' },
        el('div', { class: 'rt-hero' },
          el('span', { class: 'kpi-label' }, aicon('users', { size: 14 }), 'Online now'),
          el('span', { class: 'hero-num' }, num(d.counts.total)),
          el('span', { class: 'kpi-sub' }, `${plural(d.counts.signedIn, 'signed-in player')} · ${plural(d.counts.guests, 'guest')}`),
          trail.length > 1 ? lineChart(trail, [{ key: 'value', label: 'Online', color: V1 }], { unit: 'slot', height: 110, name: 'People online, last 2 hours' }) : null),
        el('div', { class: 'rt-col' },
          el('h4', { class: 'section-title' }, 'Where they are'),
          d.byPage.length
            ? barList(d.byPage.map((p) => ({ label: el('span', { class: 'with-icon' }, aicon(PAGE_ICONS[p.page] ?? 'list', { size: 15 }), PAGE_LABELS[p.page] ?? p.page), value: p.count })))
            : el('p', { class: 'muted' }, 'Nobody is on the site.'),
          el('h4', { class: 'section-title', style: 'margin-top:18px' }, 'Devices'),
          segBar(['desktop', 'mobile', 'tablet'].map((k, i) => ({
            label: DEVICE_LABELS[k], value: d.byDevice.find((x) => x.device === k)?.count ?? 0, color: [V1, V2, V3][i],
          })))),
        el('div', { class: 'rt-col' },
          el('h4', { class: 'section-title' }, 'Games right now'),
          el('div', { class: 'mini-grid' },
            mini('Live games', d.games.live, 'radio'),
            mini('In play', d.games.playing, 'gamepad'),
            mini('Lobbies', d.games.lobbies, 'history'),
            mini('Players in games', d.games.players, 'users')),
          d.games.list.length
            ? el('ul', { class: 'feed compact' }, d.games.list.slice(0, 5).map((g) => el('li', {},
              el('span', { class: 'feed-main' }, link(hrefs.game(g.code), g.code, 'mono'), ' ', statePill(g.state),
                el('span', { class: 'cell-sub' }, `${g.hostName ?? 'unknown host'} · ${plural(g.playerCount, 'player')}${g.state !== 'lobby' && g.total ? ` · Q${g.qIndex + 1}/${g.total}` : ''}`)))))
            : el('p', { class: 'muted' }, 'No games running.'))),
      onlineList(d)));
  }

  function onlineList(d) {
    const rows = d.online;
    return el('div', { class: 'online-list' },
      el('div', { class: 'card-head' },
        el('h4', { class: 'section-title' }, `Who's online (${num(rows.length)})`),
        rows.length ? el('span', { class: 'muted small-mono' }, 'Signed-in players first') : null),
      rows.length
        ? el('ul', { class: 'people' }, rows.map((s) => el('li', {},
          el('span', { class: `avatar-sm${s.userId ? '' : ' guest'}`, 'aria-hidden': 'true' }, s.userId ? initials(s.username) : aicon('user', { size: 15 })),
          el('span', { class: 'person-main' },
            s.userId ? link(hrefs.user(s.userId), s.username, 'cell-main') : el('span', { class: 'cell-main' }, 'Guest'),
            s.role === 'admin' ? [' ', el('span', { class: 'pill admin' }, 'admin')] : null,
            el('span', { class: 'cell-sub' }, `${PAGE_LABELS[s.page] ?? s.page}${s.game ? ' ' : ''}`, s.game ? link(hrefs.game(s.game), s.game, 'mono') : null),
            el('span', { class: 'person-meta' },
              el('span', { class: 'with-icon', title: `${s.browser} on ${s.os}` }, aicon(DEVICE_ICONS[s.device] ?? 'monitor', { size: 13 }), `${s.browser} · ${s.os}`),
              el('span', { title: 'Time on site this visit' }, `on for ${span((d.generatedAt - s.startedAt) / 1000)}`))))))
        : empty('users', 'Nobody online right now', 'People show up here a few seconds after they open any Quibble page.'));
  }

  // ---------- report ----------
  function drawReport() {
    const r = report;
    const t = r.totals;
    const p = r.prev;
    const s = r.series;
    const period = PERIOD[r.range];
    fill(slots.report,
      el('div', { class: 'kpis kpis-4' },
        tile('Visitors', 'users', t.visitors, p.visitors, period, s.map((x) => x.visitors), `${num(r.newVisitors)} new · ${num(r.returningVisitors)} returning`),
        tile('Sessions', 'pulse', t.sessions, p.sessions, period, s.map((x) => x.sessions), t.visitors ? `${(t.sessions / t.visitors).toFixed(1)} per visitor` : null),
        tile('Signed-in players', 'user', t.signedIn, p.signedIn, period, s.map((x) => x.signedIn), `${num(r.audience.guestSessions)} guest sessions`),
        tile('Avg. engaged time', 'clock', t.avgSessionSec, p.avgSessionSec, period, s.map((x) => x.activeMin), `${compact(Math.round(t.activeSec / 60))} min in total`, { format: span }),
        tile('Peak online', 'trendUp', t.peak, p.peak, period, r.concurrency.map((x) => x.value), t.peakAt ? `at ${bucketLabel(t.peakAt, 'slot')}` : 'nobody online yet'),
        tile('Bounce rate', 'logout', t.bounceRate, p.bounceRate, period, null, 'left within 15 s, one page', { format: pct, upIsGood: false }),
        tile('Games played', 'gamepad', t.games, p.games, period, s.map((x) => x.games), `${num(t.plays)} plays · ${r.gameStats.avgPlayers || 0} per game`),
        tile('New sign-ups', 'userPlus', t.signups, p.signups, period, s.map((x) => x.signups), null)),
      trafficCard(),
      el('div', { class: 'grid2' }, concurrencyCard(), heatCard()),
      el('div', { class: 'grid2' }, pagesCard(), techCard()),
      el('div', { class: 'grid2' }, durationCard(), audienceCard()),
      el('div', { class: 'grid2 wide-left' }, topUsersCard(), gamesCard()),
      sessionsCard());
  }

  function trafficCard() {
    const m = METRICS.find((x) => x.id === metric);
    const totals = { visitors: report.totals.visitors, activeMin: Math.round(report.totals.activeSec / 60), signedIn: report.totals.signedIn, plays: report.totals.plays, signups: report.totals.signups };
    const main = m.series[0];
    return el('div', { class: 'card' },
      el('div', { class: 'chart-head' },
        el('div', {},
          el('h3', {}, `${m.label} ${report.unit === 'hour' ? 'by hour' : 'by day'}`),
          el('div', { class: 'chart-total' }, compact(totals[main.key] ?? 0), el('small', {}, `${main.label.toLowerCase()}, last ${RANGES.find(([v]) => v === range)[1]}`))),
        segmented(METRICS.map((x) => [x.id, x.label]), metric, (v) => { metric = v; drawReport(); }, 'Metric')),
      lineChart(report.series, m.series, { unit: report.unit, name: `${m.label} over time` }));
  }

  function concurrencyCard() {
    const step = report.concurrencyStep;
    return el('div', { class: 'card' },
      el('div', { class: 'card-head' },
        el('div', {}, el('h3', {}, 'People online over time'),
          el('p', { class: 'card-sub' }, step === 'slot' ? 'Every 5 minutes' : `Busiest 5 minutes of each ${step}`)),
        el('span', { class: 'muted small-mono' }, `peak ${num(report.totals.peak)}`)),
      lineChart(report.concurrency, [{ key: 'value', label: 'Online', color: V2 }], { unit: step, height: 200, name: 'People online over time' }));
  }

  function heatCard() {
    return el('div', { class: 'card' },
      el('div', { class: 'card-head' },
        el('div', {}, el('h3', {}, 'When people are on'),
          el('p', { class: 'card-sub' }, 'Average people online, by weekday and hour (your time)'))),
      heatmap(report.heatmap));
  }

  function pagesCard() {
    return el('div', { class: 'card' },
      el('div', { class: 'card-head' }, el('h3', {}, 'Pages'), el('span', { class: 'muted small-mono' }, 'sessions that opened each')),
      report.pages.length
        ? barList(report.pages.sort((a, b) => b.count - a.count).map((x) => ({ label: el('span', { class: 'with-icon' }, aicon(PAGE_ICONS[x.page] ?? 'list', { size: 15 }), PAGE_LABELS[x.page] ?? x.page), value: x.count })))
        : empty('list', 'No visits in this range'));
  }

  let techTab = 'devices';
  function techCard() {
    const lists = {
      devices: report.devices.map((x) => ({ label: el('span', { class: 'with-icon' }, aicon(DEVICE_ICONS[x.device] ?? 'monitor', { size: 15 }), DEVICE_LABELS[x.device] ?? x.device), value: x.count })),
      browsers: report.browsers.map((x) => ({ label: x.browser, value: x.count })),
      os: report.os.map((x) => ({ label: x.os, value: x.count })),
      referrers: report.referrers.map((x) => ({ label: x.ref, value: x.count })),
    };
    const card = el('div', { class: 'card' });
    const paint = () => fill(card,
      el('div', { class: 'card-head' }, el('h3', {}, 'Technology & sources'),
        segmented([['devices', 'Devices'], ['browsers', 'Browsers'], ['os', 'OS'], ['referrers', 'Referrers']], techTab, (v) => { techTab = v; paint(); }, 'Breakdown')),
      lists[techTab].length ? barList(lists[techTab]) : empty('monitor', 'No visits in this range'));
    paint();
    return card;
  }

  function durationCard() {
    return el('div', { class: 'card' },
      el('div', { class: 'card-head' }, el('h3', {}, 'Session length'), el('span', { class: 'muted small-mono' }, 'engaged time per visit')),
      report.durations.some((x) => x.count) ? barList(report.durations.map((x) => ({ label: x.label, value: x.count }))) : empty('clock', 'No visits in this range'));
  }

  function audienceCard() {
    const r = report;
    return el('div', { class: 'card' },
      el('div', { class: 'card-head' }, el('h3', {}, 'Audience')),
      el('h4', { class: 'section-title' }, 'Sessions'),
      segBar([{ label: 'Signed in', value: r.audience.signedInSessions, color: V1 }, { label: 'Guests', value: r.audience.guestSessions, color: V2 }]),
      el('h4', { class: 'section-title', style: 'margin-top:18px' }, 'Visitors'),
      segBar([{ label: 'New', value: r.newVisitors, color: V1 }, { label: `Returning (seen in the ${PERIOD[r.range]})`, value: r.returningVisitors, color: V2 }]),
      el('dl', { class: 'kv', style: 'margin-top:18px' },
        el('dt', {}, 'Engaged time'), el('dd', {}, span(r.totals.activeSec)),
        el('dt', {}, 'Pages per session'), el('dd', {}, r.totals.sessions ? (r.pages.reduce((a, b) => a + b.count, 0) / r.totals.sessions).toFixed(1) : '–')));
  }

  function topUsersCard() {
    const rows = report.topUsers;
    return el('div', { class: 'card' },
      el('div', { class: 'card-head' }, el('h3', {}, 'Most active players'), link('#/users', 'All players', 'muted')),
      dataTable([
        rankColumn((x) => rows.indexOf(x) + 1),
        { label: 'Player', cell: (x) => el('span', {}, link(hrefs.user(x.userId), x.username ?? 'deleted'), el('span', { class: 'cell-sub' }, x.devices.map((dv) => DEVICE_LABELS[dv] ?? dv).join(', '))) },
        { label: 'Engaged', num: true, cls: 'nowrap', cell: (x) => span(x.activeSec) },
        { label: 'Visits', num: true, cell: (x) => num(x.sessions) },
        { label: 'Games', num: true, cell: (x) => num(x.plays) },
        { label: 'Last seen', cell: (x) => el('span', { class: 'nowrap' }, ago(new Date(x.lastSeen).toISOString())) },
      ], rows, { href: (x) => hrefs.user(x.userId), emptyNode: empty('users', 'No signed-in visits in this range') }));
  }

  function gamesCard() {
    const r = report;
    return el('div', { class: 'card' },
      el('div', { class: 'card-head' }, el('h3', {}, 'Games & quizzes'), link('#/games', 'Game history', 'muted')),
      el('div', { class: 'mini-grid' },
        mini('Games', r.totals.games, 'gamepad'),
        mini('Plays', r.totals.plays, 'pulse'),
        mini('Avg. players', r.gameStats.avgPlayers, 'users'),
        mini('Biggest game', r.gameStats.biggest, 'trophy')),
      el('h4', { class: 'section-title', style: 'margin-top:18px' }, 'Top categories'),
      r.gameStats.categories.length ? barList(r.gameStats.categories.map((c) => ({ label: c.category, value: c.count }))) : empty('gamepad', 'No finished games in this range'));
  }

  let sessionsPage = 0;
  function sessionsCard() {
    const all = report.sessions;
    const size = 15;
    const card = el('div', { class: 'card flush' });
    const paint = () => {
      const rows = all.slice(sessionsPage * size, (sessionsPage + 1) * size);
      fill(card,
        el('div', { class: 'card-head' }, el('h3', {}, 'Latest visits'), el('span', { class: 'muted small-mono' }, `${num(all.length)} most recent`)),
        dataTable([
          { label: 'Visitor', cell: (x) => el('span', { class: 'who-cell' },
            el('span', { class: `dot${x.online ? ' on' : ''}`, title: x.online ? 'Online now' : 'Offline' }),
            el('span', {}, x.userId ? link(hrefs.user(x.userId), x.username) : el('span', { class: 'cell-main' }, 'Guest'),
              el('span', { class: 'cell-sub' }, x.ref ? `from ${x.ref}` : 'direct'))) },
          { label: 'Device', cell: (x) => el('span', { class: 'with-icon nowrap' }, aicon(DEVICE_ICONS[x.device] ?? 'monitor', { size: 14 }), `${x.browser} · ${x.os}`) },
          { label: 'Pages', cell: (x) => el('span', { class: 'pills' }, x.pages.map((pg) => el('span', { class: 'pill plain' }, PAGE_LABELS[pg] ?? pg)),
            x.games.map((g) => link(hrefs.game(g), g, 'pill plain mono'))) },
          { label: 'Started', cell: (x) => el('span', { class: 'nowrap', title: new Date(x.startedAt).toLocaleString() }, ago(new Date(x.startedAt).toISOString())) },
          { label: 'Engaged', num: true, cls: 'nowrap', cell: (x) => span(x.active) },
          { label: 'Last seen', cell: (x) => (x.online ? el('span', { class: 'pill st-question' }, 'online') : el('span', { class: 'nowrap' }, ago(new Date(x.lastSeen).toISOString()))) },
        ], rows, { emptyNode: empty('history', 'No visits in this range', 'Visits are recorded from the moment this version is deployed.') }),
        all.length > size ? pagerRow(all.length, size) : null);
    };
    const pagerRow = (total, sz) => {
      const pages = Math.ceil(total / sz);
      return el('div', { class: 'pager' }, el('span', {}, `${sessionsPage * sz + 1}–${Math.min(total, (sessionsPage + 1) * sz)} of ${total}`),
        el('div', { class: 'row' },
          el('button', { type: 'button', class: 'ghost small icon-btn', 'aria-label': 'Previous page', disabled: sessionsPage <= 0, onclick: () => { sessionsPage -= 1; paint(); } }, aicon('chevronLeft', { size: 16 })),
          el('span', {}, `Page ${sessionsPage + 1} of ${pages}`),
          el('button', { type: 'button', class: 'ghost small icon-btn', 'aria-label': 'Next page', disabled: sessionsPage >= pages - 1, onclick: () => { sessionsPage += 1; paint(); } }, aicon('chevronRight', { size: 16 }))));
    };
    sessionsPage = Math.min(sessionsPage, Math.max(0, Math.ceil(all.length / size) - 1));
    paint();
    return card;
  }

  // ---------- start ----------
  await Promise.all([loadLive(), loadReport()]);
  const liveTimer = setInterval(() => { if (document.visibilityState === 'visible') loadLive(); }, LIVE_MS);
  const reportTimer = setInterval(() => { if (document.visibilityState === 'visible') loadReport({ quiet: true }); }, REPORT_MS);
  return () => { clearInterval(liveTimer); clearInterval(reportTimer); };
}

const pct = (v) => (v == null ? '–' : `${Math.round(v * 100)}%`);

function mini(label, value, iconName) {
  return el('div', { class: 'mini' }, el('span', { class: 'kpi-label' }, aicon(iconName, { size: 13 }), label), el('b', {}, typeof value === 'number' ? compact(value) : value));
}

/** A KPI tile with a delta against the previous period and a sparkline of the range. */
function tile(label, iconName, value, prev, period, trend, sub, { format = compact, upIsGood = true } = {}) {
  let delta = null;
  if (value != null && prev != null) {
    const diff = value - prev;
    const good = diff === 0 ? 'flat' : (diff > 0) === upIsGood ? 'up' : 'down';
    const change = prev > 0 ? `${diff > 0 ? '+' : ''}${Math.round((diff / prev) * 100)}%` : diff ? 'new' : '0%';
    delta = el('span', { class: 'kpi-sub' },
      el('span', { class: `delta ${good}` }, diff ? aicon(diff > 0 ? 'arrowUp' : 'arrowDown', { size: 13 }) : null, change),
      ` vs ${period}`);
  }
  return el('div', { class: 'kpi' },
    el('span', { class: 'kpi-label' }, aicon(iconName, { size: 14 }), label),
    el('span', { class: 'kpi-value' }, value == null ? '–' : format(value)),
    delta,
    sub ? el('span', { class: 'kpi-sub' }, sub) : null,
    trend && trend.length > 1 ? sparkline(trend) : null);
}
