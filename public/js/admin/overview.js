// Overview: what is happening right now, growth over a date range (with the previous range for comparison), the
// best players, the question bank and the latest sign-ups, games and admin actions.
import { api, el } from '../common.js';
import { TYPE_LABELS, TYPE_ICONS } from '../qeditor.js';
import { aicon } from './icons.js';
import {
  pageHead, kpi, columnChart, barList, dataTable, segmented, button, loading, failed, when, num, plural, hrefs, link,
  statePill, rolePill, empty, rankColumn, fill,
} from './ui.js';
import { describe, actionIcon } from './activity.js';

const RANGES = [[7, '7 days'], [30, '30 days'], [90, '90 days']];
const METRICS = [
  ['signups', 'Sign-ups', 'newUsers', 'new players'],
  ['games', 'Games', 'games', 'games played'],
  ['players', 'Active players', 'activePlayers', 'players who finished a game'],
  ['plays', 'Plays', 'plays', 'games finished, counted per player'],
];

let days = 30;
let metric = 'signups';

export async function render(body, args, ctx) {
  const tz = -new Date().getTimezoneOffset();
  let data = null;

  async function load() {
    if (!data) loading(body);
    else body.querySelector('.chart')?.classList.add('loading');
    try {
      data = await api(`/api/admin/overview?days=${days}&tz=${tz}`);
    } catch (err) {
      if (ctx.isCurrent()) failed(body, err, load);
      return;
    }
    if (!ctx.isCurrent()) return;
    ctx.setCount('live', data.now.liveGames);
    draw();
  }

  function draw() {
    const t = data.totals;
    const period = `${days} days`;
    fill(body,
      pageHead('Overview', `Everything happening in Quibble. Updated ${new Date(data.generatedAt).toLocaleTimeString()}.`,
        segmented(RANGES, days, (v) => { days = v; load(); }, 'Date range'),
        button('Refresh', 'refresh', () => load(), 'ghost')),
      liveBar(data.now),
      el('div', { class: 'kpis' },
        kpi({ label: 'New players', icon: 'userPlus', value: t.newUsers, delta: { now: t.newUsers, prev: t.newUsersPrev, period }, sub: `${num(t.users)} accounts in total` }),
        kpi({ label: 'Games played', icon: 'gamepad', value: t.games, delta: { now: t.games, prev: t.gamesPrev, period }, sub: `${num(t.gamesPlayed)} all time` }),
        kpi({ label: 'Active players', icon: 'users', value: t.activePlayers, delta: { now: t.activePlayers, prev: t.activePlayersPrev, period }, sub: 'finished at least one game' }),
        kpi({ label: 'Plays', icon: 'pulse', value: t.plays, delta: { now: t.plays, prev: t.playsPrev, period }, sub: t.games ? `${(t.plays / t.games).toFixed(1)} players per game` : 'players per game' })),
      chartCard(),
      el('div', { class: 'grid2' }, topPlayersCard(), bankCard()),
      el('div', { class: 'grid2' }, newestCard(), recentGamesCard()),
      el('div', { class: 'grid2' }, activityCard(), totalsCard(t)));
  }

  function chartCard() {
    const [, label, totalKey, what] = METRICS.find((m) => m[0] === metric);
    const points = data.series.map((s) => ({ day: s.day, value: s[metric] }));
    return el('div', { class: 'card' },
      el('div', { class: 'chart-head' },
        el('div', {},
          el('h3', {}, `${label} per day`),
          el('div', { class: 'chart-total' }, num(data.totals[totalKey]), el('small', {}, `${what}, last ${days} days`))),
        segmented(METRICS.map(([v, l]) => [v, l]), metric, (v) => { metric = v; draw(); }, 'Metric')),
      columnChart(points, { name: label.toLowerCase() }));
  }

  function topPlayersCard() {
    return el('div', { class: 'card' },
      el('div', { class: 'card-head' }, el('h3', {}, 'Top players'), link('#/leaderboard', 'Leaderboards', 'muted')),
      dataTable([
        rankColumn((r) => data.topPlayers.indexOf(r) + 1),
        { label: 'Player', cell: (r) => el('span', {}, link(hrefs.user(r.userId), r.username), r.banned ? [' ', el('span', { class: 'pill bad' }, 'banned')] : null) },
        { label: 'Points', num: true, cell: (r) => num(r.totalScore) },
        { label: 'Games', num: true, cell: (r) => num(r.games) },
        { label: 'Wins', num: true, cell: (r) => num(r.wins) },
      ], data.topPlayers, { href: (r) => hrefs.user(r.userId), emptyNode: empty('trophy', 'No finished games yet') }));
  }

  function bankCard() {
    const cats = data.byCategory.slice(0, 8);
    const rest = data.byCategory.length - cats.length;
    return el('div', { class: 'card' },
      el('div', { class: 'card-head' }, el('h3', {}, 'Question bank'), link('#/questions', 'Manage', 'muted')),
      el('div', { class: 'mini-stats' },
        el('span', {}, el('b', {}, num(data.totals.questions)), 'questions'),
        el('span', {}, el('b', {}, num(data.totals.categories)), 'categories')),
      cats.length ? barList(cats.map((c) => ({ label: c.category, value: c.count }))) : empty('help', 'No questions yet'),
      rest > 0 ? el('p', { class: 'hint' }, `+ ${plural(rest, 'more category', 'more categories')}`) : null,
      data.byType.length ? [el('h4', { class: 'section-title', style: 'margin-top:20px' }, 'By type'),
        barList(data.byType.map((x) => ({ label: el('span', { class: 'with-icon' }, aicon(TYPE_ICONS[x.type] ?? 'choice', { size: 15 }), TYPE_LABELS[x.type] ?? x.type), value: x.count })))] : null);
  }

  function newestCard() {
    return el('div', { class: 'card' },
      el('div', { class: 'card-head' }, el('h3', {}, 'Newest players'), link('#/users', 'All players', 'muted')),
      data.recentUsers.length
        ? el('ul', { class: 'feed' }, data.recentUsers.map((u) => el('li', {},
          el('span', { class: 'feed-icon' }, aicon('user', { size: 16 })),
          el('span', { class: 'feed-main' }, link(hrefs.user(u.id), u.username, ''), ' ', u.role === 'admin' ? rolePill(u.role) : null, u.banned ? el('span', { class: 'pill bad' }, 'banned') : null),
          el('span', { class: 'feed-time' }, when(u.createdAt)))))
        : empty('users', 'No players yet'));
  }

  function recentGamesCard() {
    return el('div', { class: 'card' },
      el('div', { class: 'card-head' }, el('h3', {}, 'Recent games'), link('#/games', 'Game history', 'muted')),
      data.recentGames.length
        ? el('ul', { class: 'feed' }, data.recentGames.map((g) => el('li', {},
          el('span', { class: 'feed-icon' }, aicon('gamepad', { size: 16 })),
          el('span', { class: 'feed-main' }, link(hrefs.game(g.code), g.code, 'mono'), ' ', statePill(g.state),
            el('span', { class: 'cell-sub' }, `${g.hostName ?? 'unknown host'} · ${plural(g.playerCount, 'player')} · ${g.quizTitle ?? g.category ?? 'All categories'}`)),
          el('span', { class: 'feed-time' }, when(g.createdAt)))))
        : empty('gamepad', 'No games yet'));
  }

  function activityCard() {
    return el('div', { class: 'card' },
      el('div', { class: 'card-head' }, el('h3', {}, 'Admin activity'), link('#/activity', 'Activity log', 'muted')),
      data.recentAudit.length
        ? el('ul', { class: 'feed' }, data.recentAudit.map((e) => el('li', {},
          el('span', { class: 'feed-icon' }, aicon(actionIcon(e), { size: 16 })),
          el('span', { class: 'feed-main' }, describe(e)),
          el('span', { class: 'feed-time' }, when(e.at)))))
        : empty('list', 'No admin activity yet', 'Changes made from this panel show up here.'));
  }

  await load();
}

function liveBar(now) {
  return el('div', { class: 'livebar' },
    el('span', { class: 'livebar-title' }, el('span', { class: `dot${now.liveGames ? ' live' : ''}` }), 'Right now'),
    el('span', { class: 'livebar-item' }, el('b', {}, num(now.onlineUsers)), 'players online'),
    el('span', { class: 'livebar-item' }, el('b', {}, num(now.liveGames)), now.liveGames === 1 ? 'live game' : 'live games'),
    el('span', { class: 'livebar-item' }, el('b', {}, num(now.playersInGames)), 'players in games'),
    el('span', { class: 'livebar-item' }, el('b', {}, num(now.lobbies)), now.lobbies === 1 ? 'lobby waiting' : 'lobbies waiting'),
    el('a', { class: 'btn ghost small with-icon', href: '#/live' }, 'Live games', aicon('chevronRight', { size: 15 })));
}

function totalsCard(t) {
  const row = (label, value, href) => [el('dt', {}, label), el('dd', {}, href ? link(href, value, '') : value)];
  return el('div', { class: 'card' },
    el('div', { class: 'card-head' }, el('h3', {}, 'All time')),
    el('dl', { class: 'kv' },
      row('Accounts', num(t.users), '#/users'),
      row('Admins', num(t.admins)),
      row('Banned', num(t.banned)),
      row('Games played', num(t.gamesPlayed), '#/games'),
      row('Questions', `${num(t.questions)} in ${plural(t.categories, 'category', 'categories')}`, '#/questions'),
      row('Player quizzes', `${num(t.quizzes)} (${num(t.sharedQuizzes)} shared)`, '#/quizzes')));
}
