// Players: every account (search, filter, sort, CSV export) and one account in full, with the moderation actions:
// rename, admin role, ban (with a reason), kick from a game, sign out everywhere, reset password, delete.
import { api, el, toast, confirmDialog } from '../common.js';
import { aicon } from './icons.js';
import {
  pageHead, kpi, dataTable, pager, searchBox, segmented, select, button, act, loading, failed, empty, when, dateTime,
  num, plural, hrefs, link, rolePill, statePill, onlineDot, copyButton, formDialog, secretDialog, typeToConfirm, back,
  download, pill, fill,
} from './ui.js';

const PAGE = 25;
const FILTERS = [['all', 'All'], ['online', 'Online'], ['admins', 'Admins'], ['banned', 'Banned']];
const SORTS = [
  ['newest', 'Newest first'], ['oldest', 'Oldest first'], ['points', 'Most points'], ['games', 'Most games'],
  ['active', 'Recently active'], ['name', 'Name A–Z'],
];
const SORTERS = {
  newest: (a, b) => String(b.createdAt).localeCompare(String(a.createdAt)),
  oldest: (a, b) => String(a.createdAt).localeCompare(String(b.createdAt)),
  points: (a, b) => b.totalScore - a.totalScore,
  games: (a, b) => b.gamesPlayed - a.gamesPlayed,
  active: (a, b) => String(lastActive(b)).localeCompare(String(lastActive(a))),
  name: (a, b) => a.username.localeCompare(b.username),
};
const lastActive = (u) => [u.lastLoginAt, u.lastPlayedAt].filter(Boolean).sort().at(-1) ?? '';
const view = { filter: 'all', sort: 'newest', q: '', page: 0 };

export async function render(body, args, ctx) {
  if (args[0]) return renderUser(body, args[0], ctx);
  let users;
  loading(body);
  try {
    ({ users } = await api('/api/admin/users'));
  } catch (err) {
    return failed(body, err, () => render(body, args, ctx));
  }
  if (!ctx.isCurrent()) return undefined;
  const results = el('div');

  const matches = (u) => {
    const q = view.q.toLowerCase();
    const filterOk = view.filter === 'all'
      || (view.filter === 'online' && u.online) || (view.filter === 'admins' && u.role === 'admin') || (view.filter === 'banned' && u.banned);
    return filterOk && (!q || u.username.toLowerCase().includes(q) || u.email.toLowerCase().includes(q));
  };

  function drawResults() {
    const rows = users.filter(matches).sort(SORTERS[view.sort]);
    view.page = Math.min(view.page, Math.max(0, Math.ceil(rows.length / PAGE) - 1));
    fill(results, el('div', { class: 'card flush' },
      dataTable([
        {
          label: 'Player', cell: (u) => el('span', { class: 'who-cell' }, onlineDot(u.online),
            el('span', {}, link(hrefs.user(u.id), u.username), el('span', { class: 'cell-sub' }, u.email))),
        },
        { label: 'Role', cell: (u) => rolePill(u.role) },
        { label: 'Status', cell: (u) => (u.banned ? pill('banned', 'bad') : u.currentGame ? el('span', { class: 'muted' }, 'in a game') : el('span', { class: 'muted' }, 'active')) },
        { label: 'Games', num: true, cell: (u) => num(u.gamesPlayed) },
        { label: 'Points', num: true, cell: (u) => num(u.totalScore) },
        { label: 'Joined', cell: (u) => when(u.createdAt) },
        { label: 'Last login', cell: (u) => when(u.lastLoginAt) },
      ], rows.slice(view.page * PAGE, (view.page + 1) * PAGE), {
        href: (u) => hrefs.user(u.id),
        emptyNode: empty('users', 'No players match', 'Try another search or filter.'),
      }),
      pager(rows.length, view.page, PAGE, (p) => { view.page = p; drawResults(); window.scrollTo({ top: 0 }); })));
  }

  function drawAll() {
    const online = users.filter((u) => u.online).length;
    fill(body,
      pageHead('Players', `${plural(users.length, 'account')} · ${num(online)} online now · ${num(users.filter((u) => u.banned).length)} banned`,
        button('Export CSV', 'download', () => exportCsv(users.filter(matches).sort(SORTERS[view.sort])), 'ghost')),
      el('div', { class: 'tools' },
        searchBox(view.q, 'Search username or email…', (v) => { view.q = v; view.page = 0; drawResults(); }),
        segmented(FILTERS, view.filter, (v) => { view.filter = v; view.page = 0; drawAll(); }, 'Show'),
        select(SORTS, view.sort, (v) => { view.sort = v; view.page = 0; drawResults(); }, 'Sort by')),
      results);
    drawResults();
  }
  drawAll();
  return undefined;
}

// Spreadsheet apps run cells that start with = + - @ as formulas: prefix those with an apostrophe.
const csvCell = (v) => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function exportCsv(users) {
  const cols = ['id', 'username', 'email', 'role', 'banned', 'banReason', 'createdAt', 'lastLoginAt', 'lastPlayedAt', 'gamesPlayed', 'wins', 'totalScore', 'quizzes'];
  const lines = [cols.join(','), ...users.map((u) => cols.map((c) => csvCell(u[c])).join(','))];
  download(`quibble-players-${new Date().toISOString().slice(0, 10)}.csv`, `${lines.join('\r\n')}\r\n`, 'text/csv');
  toast(`Exported ${plural(users.length, 'player')}`);
}

// ---------- one player ----------
async function renderUser(body, id, ctx) {
  let data;

  async function load() {
    try {
      data = await api(`/api/admin/users/${encodeURIComponent(id)}`);
    } catch (err) {
      if (ctx.isCurrent()) {
        if (err.status === 404) {
          fill(body, back('#/users', 'Players'), el('div', { class: 'card' }, empty('userX', 'No such player', 'The account may have been deleted.')));
        } else failed(body, err, load);
      }
      return;
    }
    if (ctx.isCurrent()) draw();
  }

  const patch = async (change, message) => {
    await api(`/api/admin/users/${encodeURIComponent(id)}`, { method: 'PATCH', body: change });
    toast(message);
    await load();
  };
  const post = async (path, message) => {
    const res = await api(`/api/admin/users/${encodeURIComponent(id)}/${path}`, { method: 'POST' });
    if (message) toast(message);
    await load();
    return res;
  };

  function draw() {
    const { user: u, stats: s } = data;
    const self = u.id === ctx.me.id;
    const accuracy = s.questionsSeen ? Math.round((s.correctAnswers / s.questionsSeen) * 100) : null;

    const live = data.currentGame; // the live game they are in (a finished game's leftover pointer doesn't count)
    const actions = [
      button('Rename', 'edit', act('Saving…', async (busy) => {
        const v = await formDialog({
          title: `Rename ${u.username}`,
          message: 'The new name shows everywhere, including past leaderboards.',
          confirmLabel: 'Rename',
          fields: [{ name: 'username', label: 'Username', value: u.username, maxlength: 20, hint: '3-20 letters, numbers or underscores' }],
          validate: ({ username }) => (/^[A-Za-z0-9_]{3,20}$/.test(username) ? null : 'Use 3-20 letters, numbers or underscores.'),
        });
        if (v && v.username !== u.username) await busy(() => patch({ username: v.username }, `Renamed to ${v.username}`));
      }), 'ghost'),
      button(u.role === 'admin' ? 'Remove admin' : 'Make admin', u.role === 'admin' ? 'shieldOff' : 'shieldCheck', act('Saving…', async (busy) => {
        const toAdmin = u.role !== 'admin';
        const ok = await confirmDialog({
          title: toAdmin ? `Make ${u.username} an admin?` : `Remove admin rights from ${u.username}?`,
          message: toAdmin ? 'Admins can see everything here and change players, questions and games.' : 'They keep their account and scores.',
          confirmLabel: toAdmin ? 'Make admin' : 'Remove admin',
          danger: !toAdmin,
        });
        if (ok) await busy(() => patch({ role: toAdmin ? 'admin' : 'player' }, toAdmin ? `${u.username} is now an admin` : `${u.username} is no longer an admin`));
      }), 'ghost'),
      live ? button('Kick from game', 'userX', act('Kicking…', async (busy) => {
        const ok = await confirmDialog({
          title: `Kick ${u.username} from game ${live.code}?`,
          message: 'They are taken out of the game and disconnected. They can join again (ban them to stop that).',
          confirmLabel: 'Kick', danger: true,
        });
        if (ok) await busy(() => post('kick', `${u.username} was kicked`));
      }), 'ghost') : null,
      button('Sign out everywhere', 'logout', act('Signing out…', async (busy) => {
        const ok = await confirmDialog({
          title: `Sign ${u.username} out everywhere?`,
          message: 'Every device they are logged in on is signed out; they can log in again with their password.',
          confirmLabel: 'Sign out',
        });
        if (ok) await busy(() => post('signout', `${u.username} was signed out everywhere`));
      }), 'ghost'),
      button('Reset password', 'key', act('Resetting…', async (busy) => {
        const ok = await confirmDialog({
          title: `Reset ${u.username}'s password?`,
          message: 'Their current password stops working and they are signed out everywhere. You get a temporary password to pass on.',
          confirmLabel: 'Reset password', danger: true,
        });
        if (!ok) return;
        const res = await busy(() => post('reset-password'));
        if (res?.password) {
          await secretDialog({ title: 'Temporary password', message: `Give this to ${u.username} privately. It is shown only once.`, secret: res.password });
        }
      }), 'ghost'),
      u.banned
        ? button('Unban', 'unlock', act('Unbanning…', async (busy) => {
          const ok = await confirmDialog({ title: `Unban ${u.username}?`, message: 'They can log in and play again, and come back on the leaderboards.', confirmLabel: 'Unban' });
          if (ok) await busy(() => patch({ banned: false }, `${u.username} was unbanned`));
        }), 'ghost')
        : button('Ban', 'ban', act('Banning…', async (busy) => {
          const v = await formDialog({
            title: `Ban ${u.username}?`,
            message: 'They are kicked out of any game, signed out, hidden from the leaderboards and can no longer log in.',
            confirmLabel: 'Ban', danger: true,
            fields: [{ name: 'reason', label: 'Reason (only admins see it)', type: 'textarea', rows: 3, maxlength: 200, placeholder: 'e.g. offensive username' }],
          });
          if (v) await busy(() => patch({ banned: true, ...(v.reason ? { banReason: v.reason } : {}) }, `${u.username} was banned`));
        }), 'ghost danger'),
      button('Delete account', 'trash', act('Deleting…', async (busy) => {
        const ok = await typeToConfirm({
          title: `Delete ${u.username}?`,
          message: `This deletes the account, its ${plural(s.gamesPlayed, 'game result')} and ${plural(data.quizzes.length, 'quiz', 'quizzes')}. It can't be undone.`,
          expected: u.username,
        });
        if (!ok) return;
        await busy(() => api(`/api/admin/users/${encodeURIComponent(id)}`, { method: 'DELETE' }));
        toast(`${u.username} was deleted`);
        location.hash = '#/users';
      }), 'danger'),
    ];
    if (self) for (const b of actions.slice(1)) if (b) b.disabled = true;

    fill(body,
      back('#/users', 'Players'),
      el('div', { class: 'card' },
        el('div', { class: 'detail-head' },
          el('span', { class: 'avatar', 'aria-hidden': 'true' }, u.username.slice(0, 1)),
          el('h2', {}, u.username, rolePill(u.role), u.banned ? pill('banned', 'bad') : null, self ? pill('you') : null),
          el('div', { class: 'detail-meta' },
            el('span', { class: 'who-cell' }, onlineDot(u.online), u.online ? `Online (${plural(data.sessions.length, 'tab')})` : 'Offline'),
            el('span', {}, u.email, ' ', copyButton(u.email, 'Copy email')),
            el('span', { title: dateTime(u.createdAt) }, 'Joined ', when(u.createdAt)),
            el('span', { title: dateTime(u.lastLoginAt) }, 'Last login ', when(u.lastLoginAt)),
            el('span', { class: 'mono' }, u.id.slice(0, 8), ' ', copyButton(u.id, 'Copy user id')))),
        u.banned ? el('div', { class: 'notice bad' }, aicon('ban'),
          el('span', {}, 'Banned ', when(u.bannedAt), u.bannedBy ? [' by ', link(hrefs.user(u.bannedBy.id), u.bannedBy.username, '')] : null,
            u.banReason ? `: ${u.banReason}` : '. No reason given.')) : null,
        data.currentGame ? el('div', { class: 'notice' }, aicon('gamepad'),
          el('span', {}, 'In game ', link(hrefs.game(data.currentGame.code), data.currentGame.code, 'mono'), ' ', statePill(data.currentGame.state),
            ` · hosted by ${data.currentGame.hostId === u.id ? 'them' : data.currentGame.hostName ?? 'someone'}`)) : null,
        u.passwordResetAt || u.sessionsRevokedAt ? el('p', { class: 'hint' },
          u.passwordResetAt ? `Password reset by an admin ${dateTime(u.passwordResetAt)}. ` : '',
          u.sessionsRevokedAt ? `Signed out everywhere ${dateTime(u.sessionsRevokedAt)}.` : '') : null,
        el('div', { class: 'detail-actions' }, actions),
        self ? el('p', { class: 'hint' }, 'This is your own account: role, ban and sign-in actions are off.') : null),
      el('div', { class: 'kpis' },
        kpi({ label: 'Games played', icon: 'gamepad', value: s.gamesPlayed, sub: u.lastPlayedAt ? ['last ', when(u.lastPlayedAt)] : 'never played' }),
        kpi({ label: 'Wins', icon: 'trophy', value: s.wins, sub: `${num(s.podiums)} top-3 finishes` }),
        kpi({ label: 'Points', icon: 'star', value: s.totalScore, sub: `best game ${num(s.bestScore)}` }),
        kpi({ label: 'Accuracy', icon: 'checkCircle', value: accuracy == null ? '–' : `${accuracy}%`, sub: `${num(s.correctAnswers)} of ${num(s.questionsSeen)} right` }),
        kpi({ label: 'Average rank', icon: 'award', value: s.averageRank ?? '–', sub: 'lower is better' })),
      el('div', { class: 'grid2' },
        el('div', { class: 'card flush' },
          el('div', { class: 'card-head' }, el('h3', {}, 'Recent games'), el('span', { class: 'muted' }, data.games.length >= 100 ? 'last 100' : plural(data.games.length, 'game'))),
          dataTable([
            { label: 'When', cell: (g) => when(g.endedAt) },
            { label: 'Game', cell: (g) => el('span', {}, link(hrefs.game(g.code), g.code, 'cell-main mono'), el('span', { class: 'cell-sub' }, g.category ?? 'All categories')) },
            { label: 'Place', num: true, cell: (g) => (g.playerCount ? `${g.rank}/${g.playerCount}` : num(g.rank)) },
            { label: 'Points', num: true, cell: (g) => num(g.score) },
            { label: 'Right', num: true, cell: (g) => (g.questionCount ? `${g.correctCount}/${g.questionCount}` : num(g.correctCount)) },
          ], data.games, { href: (g) => hrefs.game(g.code), emptyNode: empty('gamepad', 'No finished games yet') })),
        el('div', {},
          el('div', { class: 'card flush' },
            el('div', { class: 'card-head' }, el('h3', {}, 'Quizzes'), el('span', { class: 'muted' }, plural(data.quizzes.length, 'quiz', 'quizzes'))),
            dataTable([
              { label: 'Title', cell: (q) => el('span', {}, link(hrefs.quiz(q.id), q.title), el('span', { class: 'cell-sub' }, plural(q.questionCount, 'question'))) },
              { label: 'Shared', cell: (q) => (q.shared ? pill('shared', 'shared') : el('span', { class: 'muted' }, 'private')) },
              { label: 'Edited', cell: (q) => when(q.updatedAt) },
            ], data.quizzes, { href: (q) => hrefs.quiz(q.id), emptyNode: empty('layers', 'No quizzes') })),
          el('div', { class: 'card flush' },
            el('div', { class: 'card-head' }, el('h3', {}, 'Open connections'), el('span', { class: 'muted' }, plural(data.sessions.length, 'socket'))),
            dataTable([
              { label: 'Connected', cell: (c) => when(c.connectedAt) },
              { label: 'Game', cell: (c) => (c.gameCode ? link(hrefs.game(c.gameCode), c.gameCode, 'mono') : el('span', { class: 'muted' }, 'none')) },
            ], data.sessions, { emptyNode: empty('radio', 'Not connected right now') })))));
  }

  loading(body);
  await load();
  return undefined;
}
