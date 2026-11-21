// Admin console: sidebar + hash router (admin.html#/users/<id>, #/games/<code> ...). Each page lives in js/admin/ and
// exports render(body, args, ctx), which may return a cleanup function (timers) that runs when the page changes.
import { api, el, clear, setToken, setProfile } from './common.js';
import { aicon } from './admin/icons.js';
import * as overview from './admin/overview.js';
import * as games from './admin/games.js';
import * as users from './admin/users.js';
import * as questions from './admin/questions.js';
import * as quizzes from './admin/quizzes.js';
import * as boards from './admin/leaderboard.js';
import * as announce from './admin/announcement.js';
import * as activity from './admin/activity.js';
import * as security from './admin/security.js';
import * as system from './admin/system.js';

const PAGES = [
  { id: 'overview', group: 'Monitor', label: 'Overview', icon: 'dashboard', render: overview.render },
  { id: 'live', group: 'Monitor', label: 'Live games', icon: 'radio', render: games.renderLive },
  { id: 'games', group: 'Monitor', label: 'Game history', icon: 'history', render: games.render },
  { id: 'users', group: 'Manage', label: 'Players', icon: 'users', render: users.render },
  { id: 'questions', group: 'Manage', label: 'Question bank', icon: 'help', render: questions.render },
  { id: 'quizzes', group: 'Manage', label: 'Player quizzes', icon: 'layers', render: quizzes.render },
  { id: 'leaderboard', group: 'Manage', label: 'Leaderboards', icon: 'trophy', render: boards.render },
  { id: 'announcement', group: 'Manage', label: 'Announcement', icon: 'megaphone', render: announce.render },
  { id: 'activity', group: 'System', label: 'Activity log', icon: 'list', render: activity.render },
  { id: 'security', group: 'System', label: 'Security', icon: 'shield', render: security.render },
  { id: 'system', group: 'System', label: 'System health', icon: 'server', render: system.render },
];
const byId = new Map(PAGES.map((p) => [p.id, p]));

const app = document.getElementById('app');
const nav = document.getElementById('nav');
const links = new Map();
const counts = new Map();
let content = null;
let cleanup = null;
let renderSeq = 0;

const ctx = {
  me: null,
  /** A number next to a sidebar entry (e.g. live games); 0 or null hides it. */
  setCount(pageId, n) {
    counts.set(pageId, n);
    const badge = links.get(pageId)?.querySelector('.side-count');
    if (badge) {
      badge.hidden = !n;
      badge.textContent = n ? String(n) : '';
    }
  },
};

init();

async function init() {
  try {
    const { user } = await api('/api/auth/me');
    if (user.role !== 'admin') return deny('You need an admin account to see this page.');
    ctx.me = user;
  } catch (err) {
    if (err.status === 401 || err.status === 403) return deny('Please log in with an admin account first.');
    clear(app).append(el('div', { class: 'card narrow' },
      el('h2', {}, "Can't reach the server"), el('p', { class: 'error' }, err.message),
      el('button', { onclick: init }, 'Try again')));
    return;
  }
  renderNav();
  renderShell();
  window.addEventListener('hashchange', route);
  route();
}

function deny(msg) {
  clear(app).append(el('div', { class: 'card narrow' },
    el('h2', {}, 'Admins only'), el('p', { class: 'muted' }, msg), el('a', { class: 'btn', href: '/play.html' }, 'Go to login')));
}

function renderNav() {
  clear(nav).append(
    el('span', { class: 'who' }, ctx.me.username),
    el('a', { class: 'btn ghost small', href: '/play.html' }, 'Back to game'),
    el('button', {
      class: 'ghost small', onclick: () => {
        setToken(null);
        setProfile(null);
        location.href = '/play.html';
      },
    }, 'Log out'));
}

function renderShell() {
  const side = el('nav', { class: 'side', 'aria-label': 'Admin sections' });
  let group = null;
  for (const p of PAGES) {
    if (p.group !== group) {
      group = p.group;
      side.append(el('div', { class: 'side-group' }, group));
    }
    const n = counts.get(p.id);
    const a = el('a', { class: 'side-link', href: `#/${p.id}` },
      aicon(p.icon), el('span', { class: 'side-label' }, p.label),
      el('span', { class: 'side-count', hidden: !n }, n ? String(n) : ''));
    links.set(p.id, a);
    side.append(a);
  }
  side.append(el('div', { class: 'side-foot' }, `Signed in as ${ctx.me.username}`));
  content = el('section', { class: 'admin-content', 'aria-live': 'polite' });
  clear(app).append(el('div', { class: 'admin-shell' }, side, content));
}

function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  const page = byId.get(parts[0]) ?? byId.get('overview');
  for (const [id, a] of links) {
    const on = id === page.id;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  document.title = `${page.label} · Quibble Admin`;
  if (typeof cleanup === 'function') cleanup();
  cleanup = null;
  const seq = ++renderSeq;
  const body = el('div');
  clear(content).append(body);
  window.scrollTo({ top: 0 });
  // A page may render asynchronously; `isCurrent` lets it stop when the admin has moved on.
  const pageCtx = { ...ctx, isCurrent: () => seq === renderSeq };
  Promise.resolve(page.render(body, parts.slice(1), pageCtx)).then((fn) => {
    if (seq === renderSeq) cleanup = fn;
    else if (typeof fn === 'function') fn();
  });
}
