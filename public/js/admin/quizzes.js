// Player quizzes ("My quizzes"): every quiz anyone built, who owns it, whether it's shared; read one in full, stop
// sharing it or delete it.
import { api, el, toast, confirmDialog, copyText } from '../common.js';
import { answerSummary, TYPE_LABELS, TYPE_ICONS } from '../qeditor.js';
import { aicon } from './icons.js';
import {
  pageHead, dataTable, pager, searchBox, segmented, button, act, loading, failed, empty, when, dateTime, num, plural, hrefs,
  link, pill, back, fill,
} from './ui.js';

const PAGE = 25;
const FILTERS = [['all', 'All'], ['shared', 'Shared'], ['private', 'Private']];
const view = { q: '', filter: 'all', page: 0 };

async function setShared(quiz, shared, busy = (work) => work()) {
  const ok = await confirmDialog(shared
    ? { title: `Share “${quiz.title}” again?`, message: 'Anyone with its link can host it again.', confirmLabel: 'Share' }
    : { title: `Stop sharing “${quiz.title}”?`, message: 'Its link stops working for everyone but the owner, who keeps the quiz.', confirmLabel: 'Stop sharing', danger: true });
  if (!ok) return false;
  await busy(() => api(`/api/admin/quizzes/${quiz.id}`, { method: 'PATCH', body: { shared } }));
  toast(shared ? 'Shared' : 'No longer shared');
  return true;
}

async function deleteQuiz(quiz, busy = (work) => work()) {
  const ok = await confirmDialog({
    title: `Delete “${quiz.title}”?`, message: `It belongs to ${quiz.ownerName}. This can't be undone.`, confirmLabel: 'Delete', danger: true,
  });
  if (!ok) return false;
  await busy(() => api(`/api/admin/quizzes/${quiz.id}`, { method: 'DELETE' }));
  toast('Quiz deleted');
  return true;
}

const shareLink = (id) => {
  const url = new URL('play.html', location.href);
  url.search = `?quiz=${encodeURIComponent(id)}`;
  url.hash = '';
  return url.href;
};

export async function render(body, args, ctx) {
  if (args[0]) return renderQuiz(body, args[0], ctx);
  let quizzes;
  loading(body);
  try {
    ({ quizzes } = await api('/api/admin/quizzes'));
  } catch (err) {
    return failed(body, err, () => render(body, args, ctx));
  }
  if (!ctx.isCurrent()) return undefined;
  const reload = () => render(body, args, ctx);
  const results = el('div');
  const matches = (q) => {
    const s = view.q.toLowerCase();
    return (view.filter === 'all' || (view.filter === 'shared') === q.shared)
      && (!s || q.title.toLowerCase().includes(s) || String(q.ownerName).toLowerCase().includes(s));
  };

  function drawResults() {
    const rows = quizzes.filter(matches);
    view.page = Math.min(view.page, Math.max(0, Math.ceil(rows.length / PAGE) - 1));
    fill(results, el('div', { class: 'card flush' },
      dataTable([
        { label: 'Quiz', cls: 'wrap-text', cell: (q) => el('span', {}, link(hrefs.quiz(q.id), q.title), q.description ? el('span', { class: 'cell-sub' }, q.description) : null) },
        { label: 'Owner', cell: (q) => link(hrefs.user(q.ownerId), q.ownerName, '') },
        { label: 'Questions', num: true, cell: (q) => num(q.questionCount) },
        { label: 'Sharing', cell: (q) => (q.shared ? pill('shared', 'shared') : el('span', { class: 'muted' }, 'private')) },
        { label: 'Edited', cell: (q) => when(q.updatedAt) },
        {
          label: '', cls: 'actions', cell: (q) => [
            q.shared ? el('button', { type: 'button', class: 'ghost small icon-btn', title: 'Stop sharing', 'aria-label': 'Stop sharing', onclick: act('…', async (busy) => { if (await setShared(q, false, busy)) await reload(); }) }, aicon('eyeOff', { size: 15 })) : null,
            el('button', { type: 'button', class: 'ghost danger small icon-btn', title: 'Delete', 'aria-label': 'Delete quiz', onclick: act('…', async (busy) => { if (await deleteQuiz(q, busy)) await reload(); }) }, aicon('trash', { size: 15 }))],
        },
      ], rows.slice(view.page * PAGE, (view.page + 1) * PAGE), {
        href: (q) => hrefs.quiz(q.id),
        emptyNode: empty('layers', quizzes.length ? 'No quizzes match' : 'No player quizzes yet', quizzes.length ? 'Try another search.' : 'Quizzes players build under "My quizzes" show up here.'),
      }),
      pager(rows.length, view.page, PAGE, (p) => { view.page = p; drawResults(); })));
  }

  function drawAll() {
    fill(body,
      pageHead('Player quizzes', `${plural(quizzes.length, 'quiz', 'quizzes')} built by players · ${num(quizzes.filter((q) => q.shared).length)} shared by link`),
      el('div', { class: 'tools' },
        searchBox(view.q, 'Search title or owner…', (v) => { view.q = v; view.page = 0; drawResults(); }),
        segmented(FILTERS, view.filter, (v) => { view.filter = v; view.page = 0; drawAll(); }, 'Show')),
      results);
    drawResults();
  }
  drawAll();
  return undefined;
}

async function renderQuiz(body, id, ctx) {
  let quiz;
  loading(body);
  try {
    ({ quiz } = await api(`/api/admin/quizzes/${encodeURIComponent(id)}`));
  } catch (err) {
    if (err.status === 404) {
      fill(body, back('#/quizzes', 'Player quizzes'), el('div', { class: 'card' }, empty('layers', 'No such quiz', 'It may have been deleted.')));
      return undefined;
    }
    return failed(body, err, () => renderQuiz(body, id, ctx));
  }
  if (!ctx.isCurrent()) return undefined;
  const reload = () => renderQuiz(body, id, ctx);
  fill(body,
    back('#/quizzes', 'Player quizzes'),
    el('div', { class: 'card' },
      el('div', { class: 'detail-head' },
        el('span', { class: 'avatar', 'aria-hidden': 'true' }, aicon('layers', { size: 28 })),
        el('h2', {}, quiz.title, quiz.shared ? pill('shared', 'shared') : pill('private')),
        el('div', { class: 'detail-meta' },
          el('span', {}, 'By ', link(hrefs.user(quiz.ownerId), quiz.ownerName, '')),
          el('span', {}, plural(quiz.questions.length, 'question')),
          el('span', { title: dateTime(quiz.createdAt) }, 'Created ', when(quiz.createdAt)),
          el('span', { title: dateTime(quiz.updatedAt) }, 'Edited ', when(quiz.updatedAt)))),
      quiz.description ? el('p', { style: 'margin:16px 0 0' }, quiz.description) : null,
      el('div', { class: 'detail-actions' },
        quiz.shared
          ? button('Stop sharing', 'eyeOff', act('Saving…', async (busy) => { if (await setShared(quiz, false, busy)) await reload(); }), 'ghost')
          : button('Share by link', 'share', act('Saving…', async (busy) => { if (await setShared(quiz, true, busy)) await reload(); }), 'ghost'),
        quiz.shared ? button('Copy share link', 'link', async () => toast((await copyText(shareLink(quiz.id))) ? 'Link copied' : shareLink(quiz.id)), 'ghost') : null,
        button('Delete quiz', 'trash', act('Deleting…', async (busy) => { if (await deleteQuiz(quiz, busy)) location.hash = '#/quizzes'; }), 'danger'))),
    el('div', { class: 'card flush' },
      el('div', { class: 'card-head' }, el('h3', {}, 'Questions'), el('span', { class: 'muted' }, 'with answers: only the owner and admins see these')),
      dataTable([
        { label: '#', cls: 'mono', cell: (q) => quiz.questions.indexOf(q) + 1 },
        { label: 'Question', cls: 'wrap-text', cell: (q) => el('span', { class: 'q-text' }, q.text) },
        { label: 'Type', cls: 'type-cell', cell: (q) => el('span', { title: TYPE_LABELS[q.type || 'choice'] }, aicon(TYPE_ICONS[q.type || 'choice'] ?? 'choice', { size: 16 })) },
        { label: 'Answer', cell: (q) => answerSummary(q) },
        { label: 'Time', num: true, cell: (q) => `${q.timeLimit ?? 20} s` },
      ], quiz.questions, { emptyNode: empty('help', 'No questions') })));
  return undefined;
}
