// Activity log: every change an admin made (who, what, when), newest first. describe() is shared with the overview.
import { api, el } from '../common.js';
import { aicon } from './icons.js';
import { pageHead, dataTable, when, dateTime, failed, loading, button, act, hrefs, link, empty, segmented, num, fill,
} from './ui.js';

const q = (text) => `“${text}”`;
const who = (t) => t?.label ?? 'someone';
const userLink = (t) => (t?.id ? link(hrefs.user(t.id), who(t), '') : who(t));

/** icon + sentence parts for each action (after the admin's name). */
const ACTIONS = {
  'question.create': ['plus', (e) => ['added the question ', q(who(e.target))]],
  'question.update': ['edit', (e) => ['edited the question ', q(who(e.target))]],
  'question.delete': ['trash', (e) => ['deleted the question ', q(who(e.target))]],
  'question.bulkDelete': ['trash', (e) => [`deleted ${num(e.details.count)} questions`]],
  'question.import': ['upload', (e) => [`imported ${num(e.details.imported)} questions`, e.details.skipped ? ` (${num(e.details.skipped)} already existed)` : '']],
  'question.importTrivia': ['globe', (e) => [`imported ${num(e.details.imported)} questions from Open Trivia DB`]],
  'category.rename': ['tag', (e) => ['moved category ', q(e.details.from), ' to ', q(e.details.to), ` (${num(e.details.moved)} questions)`]],
  'user.role': ['shieldCheck', (e) => (e.details.role === 'admin'
    ? ['made ', userLink(e.target), ' an admin']
    : ['removed admin rights from ', userLink(e.target)])],
  'user.ban': ['ban', (e) => ['banned ', userLink(e.target), e.details.reason ? `: ${e.details.reason}` : '']],
  'user.unban': ['unlock', (e) => ['unbanned ', userLink(e.target)]],
  'user.rename': ['edit', (e) => ['renamed ', q(e.details.from), ' to ', userLink(e.target)]],
  'user.kick': ['userX', (e) => ['kicked ', userLink(e.target), e.details.game ? [' from game ', link(hrefs.game(e.details.game), e.details.game, 'mono')] : ' (not in a game)']],
  'user.signout': ['logout', (e) => ['signed ', userLink(e.target), ' out everywhere']],
  'user.resetPassword': ['key', (e) => ['reset the password of ', userLink(e.target)]],
  'user.delete': ['trash', (e) => ['deleted the account ', q(who(e.target)), e.details.email ? ` (${e.details.email})` : '']],
  'game.end': ['stop', (e) => ['ended game ', link(hrefs.game(e.target.id), e.target.id, 'mono'), e.details.reason ? `: ${e.details.reason}` : '']],
  'quiz.unshare': ['eyeOff', (e) => ['stopped sharing ', link(hrefs.quiz(e.target.id), who(e.target), ''), e.details.owner ? ` by ${e.details.owner}` : '']],
  'quiz.share': ['share', (e) => ['shared ', link(hrefs.quiz(e.target.id), who(e.target), ''), e.details.owner ? ` by ${e.details.owner}` : '']],
  'quiz.delete': ['trash', (e) => ['deleted the quiz ', q(who(e.target)), e.details.owner ? ` by ${e.details.owner}` : '']],
  'announcement.set': ['megaphone', (e) => ['posted the announcement ', q(who(e.target))]],
  'announcement.clear': ['megaphone', () => ['took the announcement down']],
  'leaderboard.refresh': ['refresh', () => ['recomputed the leaderboards']],
  'ratelimit.clear': ['unlock', (e) => ['reset the limit on ', who(e.target)]],
};

export const actionIcon = (e) => ACTIONS[e.action]?.[0] ?? 'pulse';

/** "admin banned bob: spam" as DOM (names link to their pages). */
export function describe(e, { withAdmin = true } = {}) {
  const parts = ACTIONS[e.action]?.[1](e) ?? [e.action];
  return el('span', {},
    withAdmin ? [link(hrefs.user(e.admin.id), e.admin.username, ''), ' '] : null,
    parts.flat(2).filter((p) => p !== '' && p != null));
}

const GROUPS = [['all', 'All'], ['user', 'Players'], ['question', 'Questions'], ['game', 'Games'], ['quiz', 'Quizzes'], ['other', 'Other']];
const groupOf = (e) => {
  const g = e.action.split('.')[0];
  if (g === 'category') return 'question';
  return ['user', 'question', 'game', 'quiz'].includes(g) ? g : 'other';
};

let filter = 'all';

export async function render(body, args, ctx) {
  const entries = [];
  let next = null;
  const list = el('div');
  const more = button('Load older', 'chevronRight', act('Loading…', () => loadPage()), 'ghost');

  async function loadPage() {
    const res = await api(`/api/admin/audit?limit=100${next ? `&before=${encodeURIComponent(next)}` : ''}`);
    entries.push(...res.entries);
    next = res.next;
    draw();
  }

  function draw() {
    if (!ctx.isCurrent()) return;
    const shown = entries.filter((e) => filter === 'all' || groupOf(e) === filter);
    fill(body,
      pageHead('Activity log', 'Every change made from this panel: who did what, and when. Entries are kept for a year.'),
      el('div', { class: 'tools' },
        segmented(GROUPS, filter, (v) => { filter = v; draw(); }, 'Show'),
        el('span', { class: 'count' }, `${num(shown.length)} of ${num(entries.length)} loaded`)),
      el('div', { class: 'card flush' },
        dataTable([
          { label: 'When', cls: 'nowrap', cell: (e) => el('span', { title: dateTime(e.at) }, when(e.at)) },
          { label: '', cls: 'type-cell', cell: (e) => aicon(actionIcon(e), { size: 16 }) },
          { label: 'What happened', cls: 'wrap-text', cell: (e) => describe(e) },
        ], shown, { emptyNode: empty('list', entries.length ? 'Nothing of this kind yet' : 'No admin activity yet', 'Changes made from this panel show up here.') })),
      next ? el('div', { style: 'margin-top:14px' }, more) : null);
  }

  loading(body);
  try {
    await loadPage();
  } catch (err) {
    failed(body, err, () => render(body, args, ctx));
  }
}
