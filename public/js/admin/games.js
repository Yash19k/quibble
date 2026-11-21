// Games: the live monitor (auto-refreshing), the history of every stored game, and one game in full (standings,
// every question with its answer and how many got it right). Admins can end a live game for everyone.
import { api, el, toast, joinUrl, copyText } from '../common.js';
import { TYPE_LABELS, TYPE_ICONS } from '../qeditor.js';
import { aicon } from './icons.js';
import {
  pageHead, kpi, dataTable, pager, searchBox, segmented, button, act, loading, failed, empty, when, dateTime, duration,
  num, plural, hrefs, link, statePill, onlineDot, formDialog, back, rankColumn, fill,
} from './ui.js';

const LIVE_EVERY_MS = 5000;
const DETAIL_EVERY_MS = 3000;

const progress = (g) => {
  if (g.state === 'question') return `Question ${g.qIndex + 1} of ${g.total}`;
  if (g.state === 'reveal') return `Results of ${g.qIndex + 1} of ${g.total}`;
  if (g.state === 'lobby') return `Waiting · ${plural(g.total, 'question')}`;
  return plural(g.total, 'question');
};

const modeIcons = (g) => el('span', { class: 'pills' },
  g.bigScreen ? el('span', { title: 'Big-screen mode' }, aicon('monitor', { size: 15 })) : null,
  g.doublePoints ? el('span', { title: 'Double-points rounds' }, aicon('zap', { size: 15 })) : null,
  g.quizTitle ? el('span', { title: 'A player quiz' }, aicon('layers', { size: 15 })) : null);

/** Asks for an optional reason, then ends the game. Resolves true when it was ended. */
async function endGame(code, busy = (work) => work()) {
  const v = await formDialog({
    title: `End game ${code}?`,
    message: 'Everyone in it sees the game end right away, with the reason below. Scores are not saved.',
    confirmLabel: 'End game',
    danger: true,
    fields: [{ name: 'reason', label: 'Reason shown to players (optional)', placeholder: 'An admin ended the game.', maxlength: 120 }],
  });
  if (!v) return false;
  const res = await busy(() => api(`/api/admin/games/${encodeURIComponent(code)}/end`, { method: 'POST', body: v.reason ? { reason: v.reason } : {} }));
  if (!res) return false;
  toast(res.ended ? `Game ${code} ended` : `Game ${code} was already over`);
  return true;
}

const hostCell = (g) => (g.hostId ? link(hrefs.user(g.hostId), g.hostName ?? 'host', '') : el('span', { class: 'muted' }, g.hostName ?? '–'));
const topicCell = (g) => el('span', {}, g.quizTitle ?? g.category ?? 'All categories', g.quizTitle ? el('span', { class: 'cell-sub' }, 'player quiz') : null);

// ---------- live ----------
let autoRefresh = true;

export async function renderLive(body, args, ctx) {
  let games = null;
  let at = null;

  async function load() {
    try {
      games = (await api('/api/admin/games')).games.filter((g) => g.live);
      at = new Date();
    } catch (err) {
      if (!games && ctx.isCurrent()) failed(body, err, load);
      return;
    }
    if (!ctx.isCurrent()) return;
    ctx.setCount('live', games.length);
    draw();
  }

  function draw() {
    const lobbies = games.filter((g) => g.state === 'lobby');
    const toggle = el('input', { type: 'checkbox', class: 'switch', checked: autoRefresh, 'aria-label': 'Refresh automatically' });
    toggle.addEventListener('change', () => { autoRefresh = toggle.checked; });
    fill(body,
      pageHead('Live games', 'Lobbies and games in progress. Open one to watch it or end it.',
        el('label', { class: 'refresh-toggle' }, toggle, 'Auto-refresh'),
        button('Refresh', 'refresh', act('…', load), 'ghost')),
      el('div', { class: 'kpis' },
        kpi({ label: 'Live games', icon: 'radio', value: games.length }),
        kpi({ label: 'In progress', icon: 'play', value: games.length - lobbies.length }),
        kpi({ label: 'Lobbies waiting', icon: 'clock', value: lobbies.length }),
        kpi({ label: 'Players in games', icon: 'users', value: games.reduce((s, g) => s + g.playerCount, 0) })),
      el('div', { class: 'card flush' },
        el('div', { class: 'card-head' }, el('h3', {}, 'Now playing'), el('span', { class: 'updated' }, `Updated ${at.toLocaleTimeString()}`)),
        dataTable([
          { label: 'Code', cell: (g) => link(hrefs.game(g.code), g.code, 'cell-main mono') },
          { label: 'State', cell: (g) => el('span', {}, statePill(g.state), el('span', { class: 'cell-sub' }, progress(g))) },
          { label: 'Host', cell: hostCell },
          { label: 'Players', num: true, cell: (g) => num(g.playerCount) },
          { label: 'Questions from', cell: topicCell },
          { label: 'Mode', cell: modeIcons },
          { label: 'Opened', cell: (g) => when(g.createdAt) },
          { label: '', cls: 'actions', cell: (g) => button('End', 'stop', act('Ending…', async (busy) => { if (await endGame(g.code, busy)) await load(); }), 'ghost danger small') },
        ], games, { href: (g) => hrefs.game(g.code), emptyNode: empty('radio', 'No live games right now', 'Lobbies and running games show up here as soon as someone hosts one.') })));
  }

  const timer = setInterval(() => {
    if (autoRefresh && document.visibilityState === 'visible' && ctx.isCurrent()) load();
  }, LIVE_EVERY_MS);
  loading(body);
  await load();
  return () => clearInterval(timer);
}

// ---------- history ----------
const STATES = [['all', 'All'], ['live', 'Live'], ['ended', 'Finished'], ['cancelled', 'Cancelled'], ['expired', 'Expired']];
const PAGE = 25;
const view = { state: 'all', q: '', page: 0 };

export async function render(body, args, ctx) {
  if (args[0]) return renderGame(body, args[0].toUpperCase(), ctx);
  let games;
  loading(body);
  try {
    games = (await api('/api/admin/games')).games;
  } catch (err) {
    return failed(body, err, () => render(body, args, ctx));
  }
  if (!ctx.isCurrent()) return undefined;
  ctx.setCount('live', games.filter((g) => g.live).length);
  const results = el('div');

  const matches = (g) => {
    const stateOk = view.state === 'all' || (view.state === 'live' ? g.live : g.state === view.state);
    const q = view.q.toLowerCase();
    return stateOk && (!q || [g.code, g.hostName, g.category, g.quizTitle].some((s) => s && s.toLowerCase().includes(q)));
  };

  function drawResults() {
    const rows = games.filter(matches);
    view.page = Math.min(view.page, Math.max(0, Math.ceil(rows.length / PAGE) - 1));
    fill(results, el('div', { class: 'card flush' },
      dataTable([
        { label: 'Code', cell: (g) => link(hrefs.game(g.code), g.code, 'cell-main mono') },
        { label: 'State', cell: (g) => statePill(g.state) },
        { label: 'Host', cell: hostCell },
        { label: 'Players', num: true, cell: (g) => num(g.playerCount) },
        { label: 'Questions', num: true, cell: (g) => num(g.total) },
        { label: 'Questions from', cell: topicCell },
        { label: 'Opened', cell: (g) => when(g.createdAt) },
        { label: 'Length', cls: 'nowrap', cell: (g) => (g.endedAt && g.createdAt && g.state === 'ended' ? duration(Date.parse(g.endedAt) - Date.parse(g.createdAt)) : '–') },
      ], rows.slice(view.page * PAGE, (view.page + 1) * PAGE), {
        href: (g) => hrefs.game(g.code),
        emptyNode: empty('history', games.length ? 'No games match' : 'No games yet', games.length ? 'Try another filter.' : 'Games show up here once someone hosts one.'),
      }),
      pager(rows.length, view.page, PAGE, (p) => { view.page = p; drawResults(); })));
  }

  function drawAll() {
    fill(body,
      pageHead('Game history', 'Every stored game. Finished games are kept for 30 days and cancelled ones for a day; players keep their results for good.'),
      el('div', { class: 'tools' },
        searchBox(view.q, 'Search code, host or category…', (v) => { view.q = v; view.page = 0; drawResults(); }),
        segmented(STATES, view.state, (v) => { view.state = v; view.page = 0; drawAll(); }, 'State')),
      results);
    drawResults();
  }
  drawAll();
  return undefined;
}

// ---------- one game ----------
async function renderGame(body, code, ctx) {
  let data = null;
  let timer = null;

  async function load() {
    try {
      data = await api(`/api/admin/games/${encodeURIComponent(code)}`);
    } catch (err) {
      if (!data && ctx.isCurrent()) failed(body, err, load);
      return;
    }
    if (ctx.isCurrent()) draw();
  }

  function draw() {
    const g = data.game;
    const meta = [
      g.hostId ? el('span', {}, 'Host ', link(hrefs.user(g.hostId), g.hostName ?? 'host', '')) : null,
      g.createdAt ? el('span', { title: dateTime(g.createdAt) }, 'Opened ', when(g.createdAt)) : null,
      g.endedAt ? el('span', { title: dateTime(g.endedAt) }, g.state === 'cancelled' ? 'Cancelled ' : 'Ended ', when(g.endedAt)) : null,
      g.state === 'ended' && g.createdAt && g.endedAt ? el('span', {}, `Took ${duration(Date.parse(g.endedAt) - Date.parse(g.createdAt))}`) : null,
      el('span', {}, plural(g.playerCount, 'player')),
      el('span', {}, progress(g)),
    ];
    const flags = [
      g.bigScreen ? 'Big-screen mode' : null, g.doublePoints ? 'Double points' : null,
      g.live && !g.hostPlays ? 'Host presents' : null, g.live && g.hostPlays ? 'Host plays' : null,
    ].filter(Boolean);
    fill(body,
      back(g.live ? '#/live' : '#/games', g.live ? 'Live games' : 'Game history'),
      el('div', { class: 'card' },
        el('div', { class: 'detail-head' },
          el('span', { class: 'avatar code' }, g.code),
          el('h2', {}, g.quizTitle ?? g.category ?? 'All categories', statePill(g.state)),
          el('div', { class: 'detail-meta' }, meta)),
        flags.length ? el('div', { class: 'pills', style: 'margin-top:12px' }, flags.map((f) => el('span', { class: 'pill plain' }, f))) : null,
        g.state === 'cancelled' && g.cancelReason ? el('div', { class: 'notice warn' }, aicon('alert'), el('span', {}, g.cancelReason)) : null,
        g.archived ? el('div', { class: 'notice' }, aicon('infoCircle'), el('span', {}, 'This game is older than 30 days: only the final standings are left.')) : null,
        g.live ? el('div', { class: 'detail-actions' },
          button('End game', 'stop', act('Ending…', async (busy) => { if (await endGame(g.code, busy)) await load(); }), 'danger'),
          button('Copy join link', 'link', async () => {
            const url = joinUrl(g.code, location.href);
            toast((await copyText(url)) ? 'Join link copied' : url);
          }, 'ghost'),
          el('span', { class: 'updated', style: 'align-self:center' }, `${num(data.online)} of ${plural(data.players.length, 'player')} online · refreshes every 3 s`))
          : null),
      g.awards && (g.awards.streak || g.awards.sharp) ? el('div', { class: 'stat-chips', style: 'margin:0 0 20px' },
        g.awards.sharp ? el('span', { class: 'stat-chip' }, aicon('checkCircle', { size: 16 }), 'Most right: ', el('b', {}, `${g.awards.sharp.username} (${g.awards.sharp.n})`)) : null,
        g.awards.streak ? el('span', { class: 'stat-chip' }, aicon('flame', { size: 16 }), 'Longest streak: ', el('b', {}, `${g.awards.streak.username} (${g.awards.streak.n})`)) : null) : null,
      el('div', { class: 'grid2' }, standingsCard(), questionsCard()));
  }

  function standingsCard() {
    const live = data.game.live;
    return el('div', { class: 'card flush' },
      el('div', { class: 'card-head' }, el('h3', {}, live ? 'Standings' : 'Final standings'), el('span', { class: 'muted' }, plural(data.players.length, 'player'))),
      dataTable([
        rankColumn((p) => p.rank),
        { label: 'Player', cell: (p) => el('span', { class: 'who-cell' }, live ? onlineDot(p.online) : null, link(hrefs.user(p.userId), p.username)) },
        { label: 'Points', num: true, cell: (p) => num(p.score) },
        { label: 'Right', num: true, cell: (p) => num(p.correctCount) },
      ], data.players, { href: (p) => hrefs.user(p.userId), emptyNode: empty('users', 'Nobody joined', live ? 'Players appear here as they join.' : null) }));
  }

  function questionsCard() {
    const qs = data.questions;
    return el('div', { class: 'card flush' },
      el('div', { class: 'card-head' }, el('h3', {}, 'Questions'), el('span', { class: 'muted' }, qs.length ? `${qs.filter((x) => x.asked).length} of ${qs.length} asked` : '')),
      qs.length
        ? dataTable([
          { label: '#', cls: 'mono', cell: (x) => x.k + 1 },
          {
            label: 'Question', cls: 'wrap-text', cell: (x) => el('div', {},
              el('div', { class: 'q-text' }, x.text),
              el('div', { class: 'q-meta' },
                el('span', { class: 'type-cell', title: TYPE_LABELS[x.type] }, aicon(TYPE_ICONS[x.type] ?? 'choice', { size: 14 })),
                el('span', { class: 'cell-sub', style: 'margin:0' }, `Answer: ${x.answer}`),
                x.double ? el('span', { class: 'pill plain' }, '2×') : null,
                x.open ? el('span', { class: 'pill st-question' }, 'open now') : null)),
          },
          { label: 'Right', cls: 'nowrap', cell: (x) => hitRate(x) },
        ], qs)
        : empty('help', 'No question details', data.detailKept ? null : 'Per-question details are kept for a day after a game.'));
  }

  loading(body);
  await load();
  if (data?.game?.live) {
    timer = setInterval(() => {
      if (document.visibilityState === 'visible' && ctx.isCurrent() && data?.game?.live) load();
    }, DETAIL_EVERY_MS);
  }
  return () => clearInterval(timer);
}

function hitRate(x) {
  if (x.answered == null) return el('span', { class: 'muted' }, x.asked ? '…' : 'not yet');
  const base = x.players || x.answered || 0;
  const share = base ? x.right / base : 0;
  return el('span', { class: 'hit-rate', title: `${x.right} of ${base} right, ${x.answered} answered${x.fastest ? `; fastest: ${x.fastest.username} in ${(x.fastest.ms / 1000).toFixed(1)} s` : ''}` },
    el('span', { class: 'meter', 'aria-hidden': 'true' }, el('i', { style: `width:${Math.round(share * 100)}%` })),
    `${num(x.right)}/${num(base)}`);
}
