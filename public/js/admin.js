import { api, el, clear, toast, withPending } from './common.js';
import { questionEditor, answerSummary, TYPE_LABELS, TYPE_ICONS } from './qeditor.js';

const app = document.getElementById('app');
let tab = 'stats';

init();
async function init() {
  clear(app).append(el('p', { class: 'muted' }, 'Loading…'));
  try {
    const { user } = await api('/api/auth/me');
    if (user.role !== 'admin') return deny('You need an admin account to see this page.');
  } catch (err) {
    if (err.status === 401 || err.status === 403) return deny('Please log in with an admin account first.');
    return failed(app, err, init); // server busy or unreachable: not a reason to send them to the login page
  }
  render();
}

function deny(msg) {
  clear(app).append(el('div', { class: 'card narrow' }, el('h2', {}, 'Admins only'), el('p', { class: 'muted' }, msg), el('a', { class: 'btn', href: '/play.html' }, 'Go to login')));
}

/** A load failed: say why and offer a retry instead of leaving a blank page. */
function failed(body, err, retry) {
  clear(body).append(el('div', { class: 'card' },
    el('p', { class: 'error' }, err.message),
    el('button', { class: 'ghost', onclick: retry }, 'Try again')));
}

function render() {
  const body = el('div');
  clear(app).append(
    el('div', { class: 'tabs', role: 'tablist' }, ...[['stats', 'Stats'], ['questions', 'Questions'], ['users', 'Users']].map(([id, label]) =>
      el('button', { role: 'tab', 'aria-selected': String(tab === id), class: tab === id ? 'active' : '', onclick: () => { tab = id; render(); } }, label))),
    body);
  ({ stats: statsTab, questions: questionsTab, users: usersTab })[tab](body);
}

/** Click handler: shows `label` on the button while `fn` runs; errors become a toast. */
const action = (label, fn) => async (e) => {
  const button = e.currentTarget;
  await withPending(button, label, async () => {
    try { await fn(); } catch (err) { toast(err.message); }
  });
};

// ---------- stats ----------
async function statsTab(body) {
  clear(body).append(el('p', { class: 'muted' }, 'Loading…'));
  let s;
  try {
    s = await api('/api/admin/stats');
  } catch (err) {
    return failed(body, err, () => statsTab(body));
  }
  const stat = (n, label) => el('div', { class: 'stat' }, el('b', {}, n), label);
  clear(body).append(
    el('div', { class: 'stats' },
      stat(s.totals.users, 'users'), stat(s.totals.questions, 'questions'),
      stat(s.totals.gamesPlayed, 'games played'), stat(s.liveGames, 'live games now'), stat(s.totals.bannedUsers, 'banned users')),
    el('div', { class: 'grid2' },
      el('div', { class: 'card' }, el('h3', {}, 'Games per day (last 7 days)'),
        s.gamesPerDay.length ? table(['Day', 'Games'], s.gamesPerDay.map((r) => [r.day, r.games])) : el('p', { class: 'muted' }, 'No games yet.')),
      el('div', { class: 'card' }, el('h3', {}, 'Top players'),
        s.topPlayers.length ? table(['Player', 'Points', 'Games'], s.topPlayers.map((r) => [r.username, r.totalScore.toLocaleString(), r.games])) : el('p', { class: 'muted' }, 'No games yet.'))),
    el('div', { class: 'card' }, el('h3', {}, 'Questions by category'),
      table(['Category', 'Questions'], s.byCategory.map((r) => [r.category, r.count]))));
}

function table(head, rows) {
  return el('div', { class: 'table-wrap' }, el('table', {},
    el('thead', {}, el('tr', {}, head.map((h, i) => el('th', { class: i > 0 ? 'num' : '' }, h)))),
    el('tbody', {}, rows.map((r) => el('tr', {}, r.map((c, i) => el('td', { class: i > 0 ? 'num' : '' }, c)))))));
}

// ---------- questions ----------
async function questionsTab(body, search = '') {
  clear(body).append(el('p', { class: 'muted' }, 'Loading…'));
  let questions;
  try {
    ({ questions } = await api(`/api/admin/questions?q=${encodeURIComponent(search)}`));
  } catch (err) {
    return failed(body, err, () => questionsTab(body, search));
  }
  const q = el('input', { placeholder: 'Search questions…', value: search, 'aria-label': 'Search questions' });
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') questionsTab(body, q.value); });

  clear(body).append(
    el('div', { class: 'row', style: 'margin-bottom:12px' },
      el('div', { class: 'grow' }, q),
      el('button', { class: 'ghost', onclick: () => importTriviaModal(body) }, '🌐 Import from Web'),
      el('button', { onclick: () => questionForm(body, null) }, 'New question')),
    el('div', { class: 'card table-wrap' }, questions.length
      ? el('table', {},
          el('thead', {}, el('tr', {}, ['Question', 'Type', 'Category', 'Answer', ''].map((h) => el('th', {}, h)))),
          el('tbody', {}, questions.map((x) => el('tr', {},
            el('td', {}, x.text),
            el('td', { title: TYPE_LABELS[x.type || 'choice'] }, TYPE_ICONS[x.type || 'choice']),
            el('td', {}, el('span', { class: 'pill' }, x.category)),
            el('td', {}, answerSummary(x)),
            el('td', { class: 'num', style: 'white-space:nowrap' },
              el('button', { class: 'ghost small', onclick: () => questionForm(body, x) }, 'Edit'), ' ',
              el('button', { class: 'danger small', onclick: async (e) => {
                if (!confirm('Delete this question?')) return;
                await action('Deleting…', async () => {
                  await api(`/api/admin/questions/${x.id}`, { method: 'DELETE' });
                  toast('Deleted');
                  questionsTab(body, search);
                })(e);
              } }, 'Delete'))))))
      : el('p', { class: 'muted' }, 'No questions found.')));
}

function questionForm(body, existing) {
  const editor = questionEditor(existing);
  const error = el('div', { class: 'error', role: 'alert' });
  const save = el('button', { onclick: () => withPending(save, 'Saving…', async () => {
    error.textContent = '';
    let payload;
    try {
      payload = editor.read();
    } catch (e) {
      error.textContent = e.message;
      return;
    }
    try {
      await api(existing ? `/api/admin/questions/${existing.id}` : '/api/admin/questions', { method: existing ? 'PUT' : 'POST', body: payload });
      toast('Saved');
      questionsTab(body);
    } catch (e) { error.textContent = e.message; }
  }) }, 'Save');

  clear(body).append(el('div', { class: 'card' },
    el('h3', {}, existing ? 'Edit question' : 'New question'),
    editor.node,
    error,
    el('div', { class: 'row', style: 'margin-top:12px' },
      save,
      el('button', { class: 'ghost', onclick: () => questionsTab(body) }, 'Cancel'))));
  editor.focus();
}

async function importTriviaModal(body) {
  let categories = {};
  try {
    const res = await api('/api/admin/trivia/categories');
    categories = res.categories || {};
  } catch { /* fallback: "any category" only */ }

  const catSelect = el('select', { 'aria-label': 'Category' },
    el('option', { value: '' }, 'Any Category (Random)'),
    ...Object.entries(categories).map(([name, id]) => el('option', { value: id }, name)));

  const countInput = el('input', { type: 'number', min: 1, max: 50, value: 10, 'aria-label': 'Number of questions' });
  const diffSelect = el('select', { 'aria-label': 'Difficulty' },
    el('option', { value: '' }, 'Any Difficulty'),
    el('option', { value: 'easy' }, 'Easy'),
    el('option', { value: 'medium' }, 'Medium'),
    el('option', { value: 'hard' }, 'Hard'));

  const status = el('div', { class: 'muted', style: 'margin-top:10px', role: 'status' });
  const error = el('div', { class: 'error', role: 'alert' });
  const btn = el('button', {
    onclick: () => withPending(btn, 'Importing…', async () => {
      error.textContent = '';
      status.textContent = 'Fetching trivia questions from the web…';
      try {
        const res = await api('/api/admin/trivia/import', {
          method: 'POST',
          body: {
            amount: Number(countInput.value) || 10,
            category: catSelect.value,
            difficulty: diffSelect.value,
          },
        });
        toast(`Imported ${res.imported} new questions (${res.totalFetched - res.imported} duplicates skipped)`);
        questionsTab(body);
      } catch (err) {
        error.textContent = err.message;
        status.textContent = '';
      }
    }),
  }, 'Import Now');

  clear(body).append(el('div', { class: 'card narrow' },
    el('h3', {}, '🌐 Import Questions from Web'),
    el('p', { class: 'muted' }, 'Fetch multiple-choice trivia instantly from the Open Trivia Database (OpenTDB).'),
    el('label', {}, 'Category'), catSelect,
    el('label', {}, 'Number of questions (1 - 50)'), countInput,
    el('label', {}, 'Difficulty'), diffSelect,
    error, status,
    el('div', { class: 'row', style: 'margin-top:16px' },
      btn,
      el('button', { class: 'ghost', onclick: () => questionsTab(body) }, 'Cancel'))));
}

// ---------- users ----------
async function usersTab(body, search = '') {
  clear(body).append(el('p', { class: 'muted' }, 'Loading…'));
  let users;
  try {
    ({ users } = await api(`/api/admin/users?q=${encodeURIComponent(search)}`));
  } catch (err) {
    return failed(body, err, () => usersTab(body, search));
  }
  const q = el('input', { placeholder: 'Search username or email…', value: search, 'aria-label': 'Search users' });
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') usersTab(body, q.value); });
  const patch = (u, change, label, msg) => action(label, async () => {
    await api(`/api/admin/users/${u.id}`, { method: 'PATCH', body: change });
    toast(msg);
    usersTab(body, search);
  });

  clear(body).append(
    el('div', { style: 'margin-bottom:12px' }, q),
    el('div', { class: 'card table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, ['User', 'Email', 'Role', 'Games', 'Status', ''].map((h) => el('th', {}, h)))),
      el('tbody', {}, users.map((u) => el('tr', {},
        el('td', {}, u.username),
        el('td', { class: 'muted' }, u.email),
        el('td', {}, el('span', { class: `pill${u.role === 'admin' ? ' admin' : ''}` }, u.role)),
        el('td', {}, u.gamesPlayed),
        el('td', {}, u.banned ? el('span', { class: 'pill bad' }, 'banned') : 'active'),
        el('td', { style: 'white-space:nowrap' },
          el('button', { class: 'ghost small', onclick: patch(u, { role: u.role === 'admin' ? 'player' : 'admin' }, 'Saving…', 'Role updated') }, u.role === 'admin' ? 'Demote' : 'Make admin'), ' ',
          el('button', { class: `${u.banned ? 'ghost' : 'danger'} small`, onclick: patch(u, { banned: !u.banned }, u.banned ? 'Unbanning…' : 'Banning…', u.banned ? 'Unbanned' : 'Banned') }, u.banned ? 'Unban' : 'Ban'))))))));
}
