import {
  api, el, clear, toast, medal, rankCell, sleep, WS_URL, session, setNotice, withPending, copyText,
  getToken, setToken, getProfile, setProfile, getLastEmail, setLastEmail,
  randomId, decodeJwt, tokenExpired, parseJoinCode, joinUrl, splitBoard, lobbyView, isStale, isFinalAnswerError,
  confirmDialog,
} from './common.js';
import { icon, shape } from './icons.js';
import { Realtime } from './realtime.js';
import { drawQr } from './qr.js';
import { questionEditor, TYPE_LABELS, TYPE_ICONS } from './qeditor.js';

// Game protocol spoken with the server. The server answers hello with {reload: true} when it moved on.
const PROTOCOL = 3;
const JOIN_KEY = 'quibble.join'; // join-link code, kept through login / sign-up (and reloads)
const QUIZ_KEY = 'quibble.quiz'; // shared-quiz link id, kept through login / sign-up
const TYPE_ORDER = ['choice', 'truefalse', 'type', 'order', 'number'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ANSWER_KEY = 'quibble.answer'; // my pick for the current question, so a reload still shows it
const RELOAD_KEY = 'quibble.reloadedAt';

const app = document.getElementById('app');
const nav = document.getElementById('nav');

let me = null; // logged-in user (public profile)
let socket = null;
let room = null; // the game we're in, as the server last described it (null = not in a game)
let clockOffset = 0; // serverTime - clientTime, so countdowns match the server
let tick = null; // countdown of the current screen
let homeTab = 'play';
let screen = ''; // what's on screen; an update for the same screen patches it instead of redrawing
let lobbyUi = null; // DOM of the lobby on screen (patched in place: no flicker, stable buttons)
let questionUi = null; // DOM of the question on screen
let answer = null; // { key: 'CODE:index', choice, state: 'sending' | 'locked' | 'closed', note }
let joinCode = parseJoinCode(location.search) || session.get(JOIN_KEY); // from a join link
let joining = null; // code being joined automatically (shows "Joining…")
let joinFailure = null; // { code, error } of a failed automatic join, shown on the Join card
let createRid = null; // requestId of the current "Create game" intent
let updateRequired = false; // the server speaks a newer protocol and an automatic reload already happened
const finished = new Set(); // games that ended, were cancelled or that we left: late updates are ignored
let lastLobbyUpdate = 0;
let entering = 0; // hello / create / join acks in flight: pushes wait for them when we have no room yet
let buffered = [];
let roomStamp = 0; // bumped when create/join puts us in a room, so an older hello ack can't undo it
let syncDueAt = 0;
let syncing = false;
let hintTimer = null;
let lastAuthCheck = 0;
let autoJoining = false;
let categoriesCache = null;
// A shared quiz to host (play.html?quiz=<id>), resolved once the player is signed in.
let quizLink = (() => {
  const id = new URLSearchParams(location.search).get('quiz') || session.get(QUIZ_KEY);
  return id && UUID_RE.test(id) ? id : null;
})();
let linkedQuiz = null; // its summary, once looked up
// The host form's choices, kept while the page is open.
const hostPrefs = { source: 'bank', quizId: null, types: new Set(), count: 10, doublePoints: true, bigScreen: false, hostPlays: true, shuffle: false };

async function send(event, data = {}) {
  const s = socket;
  if (!s) return { ok: false, error: 'Not connected yet. Try again in a moment.' };
  const r = await s.send(event, data);
  if (!r.ok && r.error === 'unauthorized') {
    onUnauthorized(s);
    return { ...r, error: 'Reconnecting… Try again in a moment.' };
  }
  return r;
}
const serverNow = () => Date.now() + clockOffset;
const isHost = () => !!room && !!me && room.hostId === me.id;
const isPlayer = () => !!room && (room.isPlayer ?? !(isHost() && !room.hostPlays));
const isLive = () => !!room && room.status !== 'ended';

// ---------- boot (called at the bottom, once every binding of this module exists) ----------
function boot() {
  if (joinCode) session.set(JOIN_KEY, joinCode);
  if (quizLink) session.set(QUIZ_KEY, quizLink);
  const token = getToken();
  if (token && tokenExpired(token)) forgetSession();
  else if (token) {
    // Render at once from the cached profile; the socket's hello ack refreshes it. /api/auth/me only without one.
    const claims = decodeJwt(token);
    const cached = getProfile();
    me = cached?.id === claims.sub ? cached : { id: claims.sub, username: '', role: 'player' };
    if (cached?.id !== claims.sub) checkAuth();
  }
  if (me) {
    if (joinCode) joining = joinCode;
    connect();
  }
  route();
  setInterval(watchdog, 1000);
  addEventListener('online', showConnectivity);
  addEventListener('offline', showConnectivity);
  addEventListener('keydown', answerHotkey);
  showConnectivity();
}

function signedIn(user, token) {
  if (token) setToken(token);
  me = { id: user.id, email: user.email, username: user.username, role: user.role };
  setProfile(me);
  if (user.email) setLastEmail(user.email);
}

function forgetSession() {
  setToken(null);
  setProfile(null);
  me = null;
}

async function logout({ expired = false } = {}) {
  if (!expired && isLive() && !(await confirmDialog({
    title: 'Log out?', message: "You're in a game. Logging out takes you out of it on this device.", confirmLabel: 'Log out', danger: true,
  }))) return;
  if (!expired) api('/api/auth/logout', { method: 'POST', budgetMs: 3000 }).catch(() => {});
  forgetSession();
  socket?.close();
  socket = null;
  room = null;
  answer = null;
  buffered = [];
  joining = null;
  for (const key of ['reconnecting', 'busy-ws']) setNotice(key, null);
  if (expired) toast('Your session has ended. Please log in again.');
  route();
}

/** Ask the server who we are (rate-limited). Only a 401 logs out; other failures just wait for the next try. */
async function checkAuth() {
  if (Date.now() - lastAuthCheck < 30_000) return;
  lastAuthCheck = Date.now();
  try {
    const { user } = await api('/api/auth/me');
    if (me) updateMe(user);
  } catch (err) {
    if (err.status === 401 && me) logout({ expired: true });
  }
}

/**
 * The server doesn't know this socket's user (connection record gone, banned, deleted). /api/auth/me tells a dead
 * session (401 -> log out) from a lost connection record (open a fresh socket, whose $connect records it again).
 */
let unauthorizedAt = 0;
function onUnauthorized(s) {
  if (Date.now() - unauthorizedAt < 10_000) return;
  unauthorizedAt = Date.now();
  checkAuth().finally(() => {
    if (me && s === socket) s.reconnect(2000 + Math.random() * 3000);
  });
}

function updateMe(user) {
  if (!user?.id) return;
  const changed = !me || me.id !== user.id || me.username !== user.username || me.role !== user.role;
  signedIn(user);
  if (changed) renderNav();
}

function route(force = false) {
  const key = screenKey();
  if (!force && key === screen) return patchScreen();
  screen = key;
  clearInterval(tick);
  lobbyUi = null;
  questionUi = null;
  renderNav();
  document.body.classList.toggle('stage', !!room && !!me && isStage());
  if (updateRequired) return renderUpdate();
  if (!me) return renderAuth(defaultAuthMode());
  if (room) return renderRoom();
  if (joining) return renderJoining();
  renderHome();
}

function screenKey() {
  if (updateRequired) return 'update';
  if (!me) return 'auth';
  if (room) {
    const index = room.status === 'question' ? room.question?.index : room.status === 'reveal' ? room.result?.index : '';
    return `room:${room.code}:${room.status}:${index ?? ''}`;
  }
  return joining ? `joining:${joining}` : 'home';
}

function patchScreen() {
  if (room?.status === 'lobby') updateLobby();
  else if (room?.status === 'question') paintQuestion();
}

function renderNav() {
  clear(nav);
  if (!me) return;
  nav.append(...[
    el('span', { class: 'who' }, me.username || '…'),
    me.role === 'admin' ? el('a', { class: 'btn ghost small', href: '/admin.html' }, 'Admin') : null,
    el('button', { class: 'ghost small', onclick: () => logout() }, 'Log out'),
  ].filter(Boolean));
}

// ---------- socket ----------
function connect() {
  socket?.close();
  socket = new Realtime(WS_URL, getToken);
  socket.on('open', () => hello('hello'));
  socket.on('status', showConnection);
  socket.on('busy', (busy) => setNotice('busy-ws', busy ? 'Server busy, still trying…' : null));
  socket.on('close', ({ failedOpens }) => {
    if (!me) return;
    if (tokenExpired(getToken())) return logout({ expired: true });
    // Sockets keep failing before they open: maybe our token was revoked (or we were banned). Ask once.
    if (failedOpens >= 3) checkAuth();
  });
  for (const event of Object.keys(PUSHES)) socket.on(event, (data) => onPush(event, data));
  showConnection(socket.status);
}

let connectionTimer = null;
function showConnection(status) {
  clearTimeout(connectionTimer);
  if (status === 'open' || status === 'closed') return setNotice('reconnecting', null);
  // Debounced, so a quick blip doesn't flash a banner.
  const text = status === 'connecting' ? 'Connecting…' : 'Reconnecting…';
  connectionTimer = setTimeout(() => setNotice('reconnecting', text), status === 'connecting' ? 3000 : 800);
}

function showConnectivity() {
  setNotice('offline', navigator.onLine === false ? "You're offline. We'll reconnect as soon as you're back." : null);
}

/** hello on every (re)connect; sync (same thing) from the watchdog. The ack says where we are. */
async function hello(kind) {
  const s = socket;
  if (!s) return;
  const stamp = roomStamp;
  entering += 1;
  let r;
  try {
    r = await s.send(kind, { protocol: PROTOCOL });
  } finally {
    entering -= 1;
  }
  if (s !== socket) return; // logged out or replaced meanwhile
  if (!r.ok && r.timedOut) {
    // Not even the resends got through in 30 s. Ask again a bit later (a reconnect sends its own hello anyway).
    setTimeout(() => { if (s === socket && s.status === 'open') hello(kind); }, 3000 + Math.random() * 3000);
  }
  applyHello(r, stamp, s);
  replayBuffered();
  maybeAutoJoin();
}

function applyHello(r, stamp, s) {
  if (!r.ok) {
    if (r.error === 'unauthorized') onUnauthorized(s);
    return;
  }
  if (r.reload) return reloadForUpdate();
  if (r.token) setToken(r.token);
  if (r.user) updateMe(r.user);
  const raced = stamp !== roomStamp; // a create/join answered after this hello was sent
  if (r.inGame && r.snapshot) {
    if (raced && room && room.code !== r.snapshot.code) return;
    applySnapshot(r.snapshot);
    return;
  }
  if (raced && room) return; // "not in a game" predates the create / join that just put us in one
  if (r.final?.code && !finished.has(r.final.code)) return showFinal(r.final);
  if (room && room.status !== 'ended') {
    // The game ended or was cancelled while we weren't listening.
    finished.add(room.code);
    room = null;
    toast('That game is over.');
    route();
  }
}

// ---------- applying server state (version-guarded) ----------
const SETTLED_FIELDS = ['hostId', 'hostName', 'hostPlays', 'category', 'total', 'isPlayer', 'bigScreen', 'quizTitle'];
const SHOWN_STATUSES = new Set(['lobby', 'question', 'reveal', 'ended']);

/** A full snapshot (create / join / hello ack). `fromAction`: we just created or joined it ourselves. */
function applySnapshot(snap, { fromAction = false } = {}) {
  if (!snap?.code) return;
  if (fromAction) finished.delete(snap.code);
  else if (finished.has(snap.code)) return;
  if (!SHOWN_STATUSES.has(snap.status)) {
    // Cancelled, or a status this page doesn't know: there is nothing to show, so we're not in a game.
    if (room && room.code !== snap.code) return;
    if (snap.status === 'cancelled') finished.add(snap.code);
    room = null;
    toast(snap.status === 'cancelled' ? 'That game was cancelled.' : 'That game is over.');
    route();
    return;
  }
  if (isStale(room, snap)) {
    // Older than what we show: keep our phase, take only the facts that never change mid-game.
    for (const k of SETTLED_FIELDS) if (snap[k] !== undefined) room[k] = snap[k];
    return;
  }
  const prev = room;
  room = roomFromSnapshot(snap);
  if (prev && prev.code === room.code && prev.status === room.status && prev.v === room.v) {
    // Same phase as on screen. A non-host's snapshot (join / hello / sync ack) lists only me; the fuller list we
    // already have (from a room:state) is just as current, so keep it.
    if (room.status === 'lobby' && (prev.players?.length ?? 0) > room.players.length) {
      room.players = prev.players;
      room.playerCount = Math.max(room.playerCount, prev.playerCount ?? 0);
    }
    // Answer counts only grow within a question: a snapshot read a moment ago must not count backwards.
    if (room.status === 'question' && prev.question?.index === room.question?.index && prev.answerCount && room.answerCount) {
      room.answerCount.answered = Math.max(room.answerCount.answered, prev.answerCount.answered);
    }
  }
  if (room.status === 'lobby') lastLobbyUpdate = Date.now();
  if (room.status === 'ended') finished.add(room.code);
  route();
}

function roomFromSnapshot(s) {
  const next = {
    code: s.code,
    v: s.v,
    status: s.status,
    hostId: s.hostId,
    hostName: s.hostName,
    hostPlays: !!s.hostPlays,
    bigScreen: !!s.bigScreen,
    quizTitle: s.quizTitle ?? null,
    category: s.category ?? null,
    total: s.total,
    playerCount: s.playerCount ?? 0,
    isPlayer: s.isPlayer,
    players: s.players || [],
    question: null,
    answerCount: null,
    result: null,
    final: null,
  };
  if (s.status === 'question' && s.question) {
    const q = s.question;
    next.question = q;
    syncClock(q.serverNow ?? s.serverNow);
    next.answerCount = countFrom(s.answerCount ?? q.answerCount, next.playerCount);
    if ((s.answered ?? q.answered) === true) markAnswered(s.code, q.index);
  } else if (s.status === 'reveal' && s.result) {
    next.result = s.result;
    syncClock(s.result.serverNow);
  } else if (s.status === 'ended') {
    next.final = s.final || null;
  }
  return next;
}

function countFrom(c, total) {
  if (typeof c === 'number') return { answered: c, total };
  if (c && typeof c === 'object') return { answered: c.answered ?? 0, total: c.total ?? total };
  return { answered: 0, total };
}

function syncClock(serverTime) {
  if (typeof serverTime === 'number') clockOffset = serverTime - Date.now();
}

function showFinal(final) {
  finished.add(final.code);
  const same = room?.code === final.code;
  room = { ...(same ? room : { code: final.code, hostId: null, hostPlays: true }), v: final.v, status: 'ended', final };
  route();
}

const PUSHES = {
  'room:state': onRoomState,
  'question:show': onQuestionShow,
  'answer:count': onAnswerCount,
  'question:result': onQuestionResult,
  'game:end': onGameEnd,
  'game:cancelled': onGameCancelled,
  reactions: onReactions,
};

function onPush(event, data) {
  // Reactions also fly on the final screen (a finished game), and never change the game's state.
  if (event === 'reactions') {
    if (data?.code && room?.code === data.code) onReactions(data);
    return;
  }
  if (!data?.code || finished.has(data.code)) return;
  if (!room) {
    // A hello / create / join ack is about to say which game we're in: hold pushes until then.
    if (entering > 0) {
      if (buffered.length < 50) buffered.push([event, data]);
      return;
    }
    // Nothing in flight, yet the server pushes us a game: we're a member whose create / join ack got lost.
    if (event === 'room:state') return adoptLobby(data);
    if (event === 'game:end') return showFinal(data);
    if (event === 'game:cancelled') finished.add(data.code);
    else hintSync(); // a question or result: a snapshot has everything needed to show it
    return;
  }
  if (room.code !== data.code) return; // another game (e.g. a socket that was still attached to an old one)
  PUSHES[event](data);
}

/** room:state while we show no game ("room is null for that code"): show its lobby. */
function adoptLobby(s) {
  if (s.status && s.status !== 'lobby') return;
  room = roomFromSnapshot({ ...s, status: 'lobby', isPlayer: undefined });
  lastLobbyUpdate = Date.now();
  route();
}

function replayBuffered() {
  if (entering > 0 || !buffered.length) return;
  const items = buffered;
  buffered = [];
  for (const [event, data] of items) onPush(event, data);
}

function onRoomState(s) {
  // Lobby lists only matter in the lobby: a late one must never pull a running game back to it.
  if (room.status !== 'lobby' || (s.status && s.status !== 'lobby') || isStale(room, s)) return;
  if (typeof s.v === 'number') room.v = s.v;
  for (const k of ['hostId', 'hostName', 'hostPlays', 'bigScreen', 'quizTitle', 'category', 'total', 'playerCount', 'players']) {
    if (s[k] !== undefined) room[k] = s[k];
  }
  lastLobbyUpdate = Date.now();
  route();
}

function onQuestionShow(q) {
  if (isStale(room, q)) return;
  syncClock(q.serverNow);
  const playerCount = q.playerCount ?? room.playerCount;
  const same = room.status === 'question' && room.question?.index === q.index; // a duplicate push
  room = {
    ...room, v: q.v ?? room.v, status: 'question', total: q.total ?? room.total, playerCount,
    question: q, answerCount: same ? room.answerCount : { answered: 0, total: playerCount }, result: null,
  };
  route();
}

/** Index of the question on screen (-1 in the lobby). */
function shownIndex() {
  if (room.status === 'question') return room.question?.index ?? -1;
  if (room.status === 'reveal') return room.result?.index ?? -1;
  return room.status === 'lobby' ? -1 : Infinity;
}

function onAnswerCount(c) {
  if (room.status !== 'question' || room.question?.index !== c.index) {
    // Counts for a question we haven't seen: we missed its question:show. Catch up.
    if (c.index > shownIndex()) hintSync();
    return;
  }
  const prev = room.answerCount?.answered ?? 0;
  room.answerCount = { answered: Math.max(prev, c.answered ?? 0), total: c.total ?? room.answerCount?.total };
  paintAnswerCount();
}

function onQuestionResult(r) {
  if (isStale(room, r)) return;
  syncClock(r.serverNow);
  room = { ...room, v: r.v ?? room.v, status: 'reveal', total: r.total ?? room.total, playerCount: r.playerCount ?? room.playerCount, result: r };
  route();
}

function onGameEnd(end) {
  if (isStale(room, end)) return;
  finished.add(end.code);
  room = { ...room, v: end.v ?? room.v, status: 'ended', final: end };
  route();
}

function onGameCancelled(c) {
  finished.add(c.code);
  room = null;
  toast(c.reason || 'The game was cancelled.');
  route();
}

// ---------- watchdog: pushes can be lost, so an overdue phase asks the server ----------
function watchdog() {
  if (!overdue()) {
    syncDueAt = 0;
    return;
  }
  if (!syncDueAt) syncDueAt = Date.now() + Math.random() * 2000; // a whole room notices at once: spread out
  if (Date.now() < syncDueAt || syncing) return;
  syncDueAt = Date.now() + 5000; // repeat while still overdue
  sync();
}

const OVERDUE_MS = 4000; // a phase this far past its deadline (server time) without the next one: ask
const LOBBY_QUIET_MS = 30_000;

function overdue() {
  if (!room || socket?.status !== 'open') return false;
  const now = serverNow();
  if (room.status === 'question') {
    const q = room.question;
    if (!q) return true; // in a question we have no details for
    return now > (q.acceptUntil ?? q.endsAt + 1500) + OVERDUE_MS;
  }
  if (room.status === 'reveal') {
    const r = room.result;
    if (!r) return true;
    return typeof r.revealEndsAt === 'number' && now > r.revealEndsAt + OVERDUE_MS;
  }
  if (room.status === 'lobby') return Date.now() - lastLobbyUpdate > LOBBY_QUIET_MS;
  return false;
}

async function sync() {
  syncing = true;
  try {
    await hello('sync');
  } finally {
    syncing = false;
  }
}

/** Something hints that we fell behind (e.g. answer counts for an unseen question): sync soon, once. */
function hintSync() {
  if (hintTimer) return;
  const code = room?.code;
  hintTimer = setTimeout(() => {
    hintTimer = null;
    if (room?.code === code && !syncing) sync();
  }, 1500 + Math.random() * 1000);
}

// ---------- protocol update ----------
function reloadForUpdate() {
  const last = Number(session.get(RELOAD_KEY)) || 0;
  if (Date.now() - last > 10 * 60_000 && session.set(RELOAD_KEY, String(Date.now()))) {
    location.reload();
    return;
  }
  // Reloaded recently already (or can't remember that we did): don't loop, ask for a manual refresh.
  socket?.close();
  socket = null;
  updateRequired = true;
  route(true);
}

function renderUpdate() {
  clear(app).append(el('div', { class: 'card narrow center' },
    el('h2', {}, 'Quibble was updated'),
    el('p', { class: 'muted' }, 'Refresh the page to keep playing. Your game is saved.'),
    el('button', { class: 'block', onclick: () => location.reload() }, 'Refresh')));
}

// ---------- auth screen ----------
function defaultAuthMode() {
  const mode = new URLSearchParams(location.search).get('mode');
  if (mode === 'register' || mode === 'login') return mode;
  // Most people opening an invite link are new here.
  return joinCode && !getLastEmail() ? 'register' : 'login';
}

function renderAuth(mode = 'login') {
  screen = 'auth';
  const register = mode === 'register';
  const field = (id, label, input, hint) => [
    el('label', { for: id }, label),
    input,
    hint,
  ];
  const error = el('div', { class: 'error', role: 'alert' });
  const email = el('input', { id: 'auth-email', type: 'email', autocomplete: 'email', required: true, maxlength: 120, value: register ? '' : getLastEmail(), 'aria-describedby': 'auth-email-err' });
  const emailErr = el('div', { class: 'error', id: 'auth-email-err', role: 'alert' });
  const username = el('input', {
    id: 'auth-username', autocomplete: 'username', required: true, minlength: 3, maxlength: 20, pattern: '[A-Za-z0-9_]{3,20}',
    title: '3-20 letters, numbers or underscores', 'aria-describedby': 'auth-username-err',
  });
  const usernameErr = el('div', { class: 'error', id: 'auth-username-err', role: 'alert' });
  const password = el('input', { id: 'auth-password', type: 'password', autocomplete: register ? 'new-password' : 'current-password', minlength: register ? 8 : 1, maxlength: register ? 72 : 100, required: true });
  const EYE = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  const EYE_OFF = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.7 5.1A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a17.6 17.6 0 0 1-2.2 3.2M6.6 6.6C3.9 8.4 2 12 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/><path d="M2 2l20 20"/></svg>';
  const toggle = el('button', {
    type: 'button', class: 'pw-toggle', 'aria-label': 'Show password', 'aria-pressed': 'false',
    onclick: () => {
      const show = password.type === 'password';
      password.type = show ? 'text' : 'password';
      toggle.innerHTML = show ? EYE_OFF : EYE;
      toggle.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
      toggle.setAttribute('aria-pressed', String(show));
      password.focus();
    },
  });
  toggle.innerHTML = EYE;
  const submit = el('button', { class: 'block', type: 'submit' }, register ? 'Sign up' : 'Log in');

  const clearErrors = () => {
    for (const n of [error, emailErr, usernameErr]) n.textContent = '';
    email.removeAttribute('aria-invalid');
    username.removeAttribute('aria-invalid');
  };
  const showError = (err) => {
    if (err.field === 'username') {
      usernameErr.textContent = 'That username is taken';
      username.setAttribute('aria-invalid', 'true');
      username.focus();
    } else if (err.field === 'email') {
      emailErr.textContent = err.message;
      email.setAttribute('aria-invalid', 'true');
      email.focus();
    } else {
      error.textContent = err.message;
    }
  };

  const form = el('form', {
    class: 'card narrow',
    onsubmit: (e) => {
      e.preventDefault();
      clearErrors();
      const values = { email: email.value.trim(), username: username.value.trim(), password: password.value };
      withPending(submit, register ? 'Signing up…' : 'Logging in…', async () => {
        try {
          const res = register ? await signUp(values) : await logIn(values);
          signedIn(res.user, res.token);
          if (joinCode) joining = joinCode;
          connect();
          route();
        } catch (err) {
          showError(err);
        }
      });
    },
  },
  el('h2', {}, register ? 'Create your account' : 'Welcome back'),
  joinCode ? el('p', { class: 'banner info' }, `${register ? 'Sign up' : 'Log in'} to join game ${joinCode}.`) : null,
  !joinCode && quizLink ? el('p', { class: 'banner info' }, `${register ? 'Sign up' : 'Log in'} to host the quiz someone shared with you.`) : null,
  field('auth-email', 'Email', email, emailErr),
  register ? field('auth-username', 'Username', username, usernameErr) : null,
  el('label', { for: 'auth-password' }, 'Password'), el('div', { class: 'pw-field' }, password, toggle),
  register ? el('p', { class: 'hint' }, 'At least 8 characters.') : null,
  error,
  submit,
  el('p', { class: 'muted' },
    register ? 'Already have an account? ' : 'New here? ',
    el('a', { href: '#', onclick: (e) => { e.preventDefault(); renderAuth(register ? 'login' : 'register'); } },
      register ? 'Log in' : 'Create an account')));
  clear(app).append(form);
  (register || !email.value ? email : password).focus();
}

const logIn = ({ email, password }) => api('/api/auth/login', { method: 'POST', body: { email, password } });

async function signUp({ email, username, password }) {
  try {
    return await api('/api/auth/register', { method: 'POST', body: { email, username, password } });
  } catch (err) {
    if (err.status !== 409 || err.field !== 'email') throw err;
    // A retried sign-up whose first attempt went through (its response was lost) finds its own account:
    // these credentials then just work. Once more after a second, in case that attempt is still finishing.
    for (const wait of [0, 1000]) {
      await sleep(wait);
      try {
        return await logIn({ email, password });
      } catch (loginErr) {
        if (loginErr.status !== 401) throw loginErr;
      }
    }
    throw err; // someone else's email: "That email is already registered"
  }
}

// ---------- home ----------
function renderHome() {
  screen = 'home';
  const tabs = el('div', { class: 'tabs', role: 'tablist' },
    ...[['play', 'Play'], ['quizzes', 'My quizzes'], ['leaderboard', 'Leaderboard'], ['history', 'My games']].map(([id, label]) =>
      el('button', {
        role: 'tab', 'aria-selected': String(homeTab === id), class: homeTab === id ? 'active' : '',
        onclick: () => { homeTab = id; renderHome(); },
      }, label)));
  const body = el('div', { role: 'tabpanel' });
  clear(app).append(tabs, body);
  if (homeTab === 'play') playTab(body);
  if (homeTab === 'quizzes') quizzesTab(body);
  if (homeTab === 'leaderboard') leaderboardTab(body);
  if (homeTab === 'history') historyTab(body);
}

async function loadCategories() {
  if (categoriesCache && Date.now() - categoriesCache.at < 60_000) return categoriesCache;
  const { categories, types = [] } = await api('/api/categories');
  categoriesCache = { at: Date.now(), list: categories, types };
  return categoriesCache;
}

/** A ?quiz= link: look the quiz up once (after login) and pre-select it for hosting. */
async function resolveQuizLink() {
  const id = quizLink;
  quizLink = null;
  session.set(QUIZ_KEY, null);
  const url = new URL(location.href);
  if (url.searchParams.has('quiz')) {
    url.searchParams.delete('quiz');
    history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`);
  }
  try {
    const { quiz } = await api(`/api/quizzes/${encodeURIComponent(id)}`);
    linkedQuiz = quiz;
    hostPrefs.source = 'quiz';
    hostPrefs.quizId = quiz.id;
    return true;
  } catch (err) {
    if (err.status === 401) logout({ expired: true });
    else toast(err.message || "Couldn't open that quiz.");
    return false;
  }
}

/** A settings row with an on/off switch: icon, title, one line of help. */
function settingRow(input, iconName, title, help, { tip = null } = {}) {
  input.classList.add('switch');
  input.setAttribute('role', 'switch');
  const helpEl = help ? el('small', {}, help) : null;
  const row = el('div', { class: 'setting-wrap' },
    el('label', { class: 'setting' },
      el('span', { class: 'setting-icon' }, icon(iconName)),
      el('span', { class: 'setting-text' }, el('span', { class: 'setting-title' }, el('b', {}, title)), helpEl),
      input));
  if (tip) row.querySelector('.setting-title').append(tip);
  row.helpEl = helpEl;
  return row;
}

let tipSeq = 0;
/**
 * A small (i) button with a themed tooltip: shown on hover and keyboard focus, toggled by a tap (phones have no hover).
 * Escape or a tap elsewhere closes it.
 */
function infoTip(text, label = 'Why?') {
  const id = `tip${++tipSeq}`;
  const bubble = el('span', { class: 'tip-bubble', role: 'tooltip', id }, text);
  const btn = el('button', { type: 'button', class: 'tip-btn', 'aria-label': label, 'aria-describedby': id, 'aria-expanded': 'false' }, icon('info', { size: 16 }));
  const wrap = el('span', { class: 'tip' }, btn, bubble);
  const set = (open) => {
    wrap.classList.toggle('open', open);
    btn.setAttribute('aria-expanded', String(open));
  };
  btn.addEventListener('click', (e) => {
    e.preventDefault(); // inside a <label>: don't flip the switch
    e.stopPropagation();
    set(!wrap.classList.contains('open'));
  });
  btn.addEventListener('keydown', (e) => { if (e.key === 'Escape') set(false); });
  btn.addEventListener('blur', () => set(false));
  const outside = (e) => {
    if (!wrap.isConnected) return document.removeEventListener('click', outside); // the screen was redrawn
    if (!wrap.contains(e.target)) set(false);
  };
  document.addEventListener('click', outside);
  return wrap;
}

function playTab(body) {
  if (quizLink) {
    clear(body).append(el('p', { class: 'muted' }, 'Opening the shared quiz…'));
    resolveQuizLink().then(() => { if (body.isConnected) playTab(body); });
    return;
  }
  const selectedCats = new Set(); // empty = all categories
  let catCounts = new Map();
  let typeInfo = [];
  let questionCount = hostPrefs.count;
  const catGrid = el('div', { class: 'chip-grid', role: 'group', 'aria-label': 'Categories' }, el('p', { class: 'muted' }, 'Loading categories…'));
  const catHint = el('p', { class: 'field-hint' });
  const typeGrid = el('div', { class: 'chip-grid', role: 'group', 'aria-label': 'Question types' });
  const typeHint = el('p', { class: 'field-hint' });
  const countOut = el('output', { class: 'stepper-value', 'aria-live': 'polite' });
  const hostPlays = el('input', { type: 'checkbox', checked: hostPrefs.hostPlays && !hostPrefs.bigScreen, disabled: hostPrefs.bigScreen });
  const bigScreen = el('input', { type: 'checkbox', checked: hostPrefs.bigScreen });
  const doublePts = el('input', { type: 'checkbox', checked: hostPrefs.doublePoints });
  const shuffle = el('input', { type: 'checkbox', checked: hostPrefs.shuffle });
  const quizSelect = el('select', { id: 'quiz-pick' });
  const quizInfo = el('p', { class: 'field-hint' });
  const summary = el('p', { class: 'host-summary', role: 'status' });
  const createErr = el('div', { class: 'error', role: 'alert' });
  const failed = joinFailure;
  joinFailure = null;
  const code = el('input', {
    id: 'join-code', maxlength: 6, placeholder: 'ABC123', autocapitalize: 'characters', autocomplete: 'off', spellcheck: 'false',
    class: 'code-input', value: failed?.code || '', 'aria-label': 'Game code', 'aria-describedby': 'join-err',
  });
  const joinErr = el('div', { class: 'error', id: 'join-err', role: 'alert' }, failed?.error || '');

  const paintSummary = () => {
    const extras = [doublePts.checked ? 'double points' : null, bigScreen.checked ? 'big screen' : hostPlays.checked ? 'you play too' : 'you present'].filter(Boolean);
    let what;
    if (hostPrefs.source === 'quiz') {
      const opt = quizSelect.selectedOptions[0];
      what = hostPrefs.quizId && opt ? opt.textContent : 'No quiz picked yet';
    } else {
      const cats = selectedCats.size ? `${selectedCats.size} categor${selectedCats.size === 1 ? 'y' : 'ies'}` : 'all categories';
      const types = hostPrefs.types.size ? `${hostPrefs.types.size} question types` : 'every question type';
      what = `${questionCount} questions · ${cats} · ${types}`;
    }
    summary.replaceChildren(el('b', {}, what), el('span', {}, extras.join(' · ')));
  };

  hostPlays.addEventListener('change', () => { hostPrefs.hostPlays = hostPlays.checked; paintSummary(); });
  // Big-screen mode turns "Play along" off (the host's screen is the projector) and says why.
  const playTip = infoTip(
    'In big-screen mode this screen shows the questions to the whole room, so it can’t answer too. Want to play? Join from your phone with the game code.',
    'Why is Play along off?');
  const playRow = settingRow(hostPlays, 'user', 'Play along', 'Answer the questions yourself', { tip: playTip });
  const paintPlayAlong = () => {
    const big = bigScreen.checked;
    hostPlays.disabled = big;
    hostPlays.checked = !big && hostPrefs.hostPlays;
    playTip.hidden = !big;
    if (playRow.helpEl) playRow.helpEl.textContent = big ? 'Off in big-screen mode' : 'Answer the questions yourself';
  };
  bigScreen.addEventListener('change', () => {
    hostPrefs.bigScreen = bigScreen.checked;
    paintPlayAlong();
    paintSummary();
    // Point it out once, right when it happens.
    if (bigScreen.checked && !hostPlays.dataset.tipShown) {
      hostPlays.dataset.tipShown = '1';
      playTip.classList.add('open');
      setTimeout(() => playTip.classList.remove('open'), 4500);
    }
  });
  paintPlayAlong();
  doublePts.addEventListener('change', () => { hostPrefs.doublePoints = doublePts.checked; paintSummary(); });
  shuffle.addEventListener('change', () => { hostPrefs.shuffle = shuffle.checked; });
  quizSelect.addEventListener('change', () => { hostPrefs.quizId = quizSelect.value || null; paintSummary(); });

  // Number of questions: a stepper, 1-30.
  const setCount = (n) => {
    questionCount = Math.min(30, Math.max(1, n));
    hostPrefs.count = questionCount;
    countOut.textContent = String(questionCount);
    minus.disabled = questionCount <= 1;
    plus.disabled = questionCount >= 30;
    paintSummary();
  };
  const minus = el('button', { type: 'button', class: 'ghost icon-btn', 'aria-label': 'Fewer questions', onclick: () => setCount(questionCount - (questionCount > 5 ? 5 : 1)) }, icon('minus'));
  const plus = el('button', { type: 'button', class: 'ghost icon-btn', 'aria-label': 'More questions', onclick: () => setCount(questionCount + (questionCount >= 5 ? 5 : 1)) }, icon('plus'));

  // "All" clears the selection; any other chip toggles in or out (pick as many as you like).
  function toggleCat(value) {
    if (!value) selectedCats.clear();
    else if (selectedCats.has(value)) selectedCats.delete(value);
    else selectedCats.add(value);
    catGrid.querySelectorAll('.chip').forEach((b) => {
      const on = b.dataset.cat ? selectedCats.has(b.dataset.cat) : selectedCats.size === 0;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    });
    const pool = selectedCats.size
      ? [...selectedCats].reduce((s, c) => s + (catCounts.get(c) || 0), 0)
      : [...catCounts.values()].reduce((s, n) => s + n, 0);
    catHint.textContent = `${selectedCats.size ? `${selectedCats.size} selected` : 'All categories'} · ${pool} questions`;
    paintTypes();
  }

  // Question types: an empty set means every type.
  const typeCount = (t) => {
    const info = typeInfo.find((x) => x.type === t);
    if (!info) return 0;
    return selectedCats.size ? [...selectedCats].reduce((s, c) => s + (info.byCategory?.[c] || 0), 0) : info.count;
  };
  function toggleType(t) {
    if (!hostPrefs.types.size) hostPrefs.types = new Set(TYPE_ORDER.filter((x) => x !== t));
    else if (hostPrefs.types.has(t)) {
      if (hostPrefs.types.size === 1) return toast('Keep at least one question type.');
      hostPrefs.types.delete(t);
    } else {
      hostPrefs.types.add(t);
      if (hostPrefs.types.size === TYPE_ORDER.length) hostPrefs.types.clear();
    }
    paintTypes();
  }
  function paintTypes() {
    const on = (t) => !hostPrefs.types.size || hostPrefs.types.has(t);
    clear(typeGrid).append(...TYPE_ORDER.map((t) => el('button', {
      type: 'button', class: `chip${on(t) ? ' active' : ''}`, 'aria-pressed': String(on(t)), onclick: () => toggleType(t),
    }, icon(TYPE_ICONS[t], { size: 16 }), TYPE_LABELS[t], el('span', { class: 'chip-count' }, typeCount(t)))));
    const matching = TYPE_ORDER.filter(on).reduce((s, t) => s + typeCount(t), 0);
    typeHint.textContent = `${hostPrefs.types.size ? `${hostPrefs.types.size} of ${TYPE_ORDER.length} types` : 'Every type'} · ${matching} matching questions`;
    paintSummary();
  }

  const sourceBtns = [['bank', 'shuffle', 'Question bank'], ['quiz', 'file', 'One of my quizzes']].map(([id, ic, label]) =>
    el('button', { type: 'button', 'data-src': id, onclick: () => setSource(id) }, icon(ic, { size: 16 }), label));
  const bankPanel = el('div', { class: 'host-fields' },
    el('div', { class: 'field' }, el('span', { class: 'field-label' }, 'Categories'), catGrid, catHint),
    el('div', { class: 'field' }, el('span', { class: 'field-label' }, 'Question types'), typeGrid, typeHint),
    el('div', { class: 'field' }, el('span', { class: 'field-label', id: 'count-label' }, 'Number of questions'),
      el('div', { class: 'stepper', role: 'group', 'aria-labelledby': 'count-label' }, minus, countOut, plus)));
  const quizPanel = el('div', { class: 'host-fields' },
    el('div', { class: 'field' }, el('label', { class: 'field-label', for: 'quiz-pick' }, 'Quiz'), quizSelect, quizInfo),
    settingRow(shuffle, 'shuffle', 'Shuffle the questions', 'Otherwise they come in the order you wrote them'));
  function setSource(id) {
    hostPrefs.source = id;
    bankPanel.hidden = id !== 'bank';
    quizPanel.hidden = id !== 'quiz';
    sourceBtns.forEach((b) => {
      b.classList.toggle('active', b.dataset.src === id);
      b.setAttribute('aria-pressed', String(b.dataset.src === id));
    });
    if (id === 'quiz') loadQuizChoices();
    paintSummary();
  }
  async function loadQuizChoices() {
    clear(quizSelect).append(el('option', { value: '' }, 'Loading…'));
    let mine = [];
    try {
      ({ quizzes: mine } = await api('/api/quizzes'));
    } catch (err) {
      if (err.status === 401) return logout({ expired: true });
      quizInfo.textContent = err.message;
    }
    const list = [...(linkedQuiz && !mine.some((q) => q.id === linkedQuiz.id) ? [linkedQuiz] : []), ...mine];
    if (!list.some((q) => q.id === hostPrefs.quizId)) hostPrefs.quizId = null;
    clear(quizSelect).append(
      el('option', { value: '' }, list.length ? 'Pick a quiz…' : 'No quizzes yet'),
      ...list.map((q) => el('option', { value: q.id }, `${q.title} · ${q.questionCount} question${q.questionCount === 1 ? '' : 's'}${q.ownerId !== me.id ? ` · by ${q.ownerName}` : ''}`)));
    quizSelect.value = hostPrefs.quizId || '';
    quizInfo.replaceChildren(list.length ? '' : el('span', {}, 'You have no quizzes yet. ',
      el('a', { href: '#', onclick: (e) => { e.preventDefault(); homeTab = 'quizzes'; renderHome(); } }, 'Build one in My quizzes'), '.'));
    paintSummary();
  }

  const createBtn = el('button', { class: 'block', onclick: () => {
    createErr.textContent = '';
    const common = { hostPlays: hostPlays.checked && !bigScreen.checked, bigScreen: bigScreen.checked, doublePoints: doublePts.checked };
    if (hostPrefs.source === 'quiz') {
      if (!hostPrefs.quizId) {
        createErr.textContent = 'Pick a quiz first.';
        quizSelect.focus();
        return;
      }
      createGame(createBtn, createErr, { ...common, quizId: hostPrefs.quizId, shuffle: shuffle.checked });
      return;
    }
    createGame(createBtn, createErr, { ...common, categories: [...selectedCats], types: [...hostPrefs.types], count: questionCount });
  } }, 'Create game');

  const joinBtn = el('button', { type: 'submit' }, 'Join');
  const joinForm = el('form', { class: 'card join-card', onsubmit: (e) => { e.preventDefault(); joinGame(code.value, joinBtn, joinErr); } },
    el('div', { class: 'join-copy' },
      el('h3', {}, 'Join a game'),
      el('p', { class: 'muted' }, 'Enter the code on the host’s screen, or scan their QR code.')),
    el('div', { class: 'join-row' }, code, joinBtn),
    joinErr);

  if (linkedQuiz && hostPrefs.quizId === linkedQuiz.id) {
    body.append(el('div', { class: 'banner info' }, `Shared quiz “${linkedQuiz.title}” by ${linkedQuiz.ownerName} is ready to host below.`));
  }
  body.append(
    joinForm,
    el('div', { class: 'card host-card' },
      el('div', { class: 'host-head' },
        el('h3', {}, 'Host a game'),
        el('p', { class: 'muted' }, 'Pick the questions, choose how to play, and share the code.')),
      el('div', { class: 'host-grid' },
        el('section', { class: 'host-col', 'aria-label': 'Questions' },
          el('h4', { class: 'section-title' }, 'Questions'),
          el('div', { class: 'tabs seg', role: 'group', 'aria-label': 'Where the questions come from' }, sourceBtns),
          bankPanel,
          quizPanel),
        el('section', { class: 'host-col host-side', 'aria-label': 'Game settings' },
          el('h4', { class: 'section-title' }, 'Game settings'),
          settingRow(doublePts, 'zap', 'Double-points rounds', 'The final question and a few others score 2×'),
          settingRow(bigScreen, 'monitor', 'Big-screen mode', 'Put the game on a projector or TV for the room'),
          playRow,
          summary,
          createErr,
          createBtn))));
  setCount(questionCount);
  setSource(hostPrefs.source);
  paintTypes();
  if (failed) code.focus();

  loadCategories().then(({ list: categories, types }) => {
    catCounts = new Map(categories.map((c) => [c.category, c.count]));
    typeInfo = types;
    clear(catGrid).append(
      el('button', { type: 'button', class: 'chip', 'data-cat': '', onclick: () => toggleCat('') },
        'All', el('span', { class: 'chip-count' }, categories.reduce((s, c) => s + c.count, 0))),
      ...categories.map((c) => el('button', { type: 'button', class: 'chip', 'data-cat': c.category, onclick: () => toggleCat(c.category) },
        c.category, el('span', { class: 'chip-count' }, c.count))));
    toggleCat(''); // start on "All"
    if (!categories.length) createErr.textContent = 'No questions yet. An admin needs to add some (or run npm run seed).';
  }).catch((err) => {
    clear(catGrid).append(el('p', { class: 'muted' }, "Couldn't load the categories. All categories will be used."));
    paintTypes();
    if (err.status === 401) logout({ expired: true });
  });
}

async function createGame(btn, errEl, settings) {
  errEl.textContent = '';
  // One id per "create" intent: the socket's resends and a retry click after a timeout reuse it, so the server
  // hands back the game it may already have made instead of making a second one.
  createRid ??= randomId();
  const r = await withPending(btn, 'Creating…', () => enterRoom('game:create', { ...settings, requestId: createRid }));
  if (!r) return;
  if (r.ok || !r.timedOut) createRid = null;
  if (!r.ok) enterFailed(r, errEl);
}

/** A create / join was refused. "Already in a game" means the server knows a game this page lost track of: sync. */
function enterFailed(r, errEl) {
  if (errEl) errEl.textContent = r.error;
  if (/already in/i.test(r.error || '') && !room) sync();
}

async function joinGame(rawCode, btn, errEl) {
  errEl.textContent = '';
  const code = rawCode.trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code)) {
    errEl.textContent = 'Game codes have 6 letters and numbers.';
    return;
  }
  const r = await withPending(btn, 'Joining…', () => enterRoom('room:join', { code }));
  if (r && !r.ok) enterFailed(r, errEl);
}

/** create / join: on success the ack carries the game's snapshot. */
async function enterRoom(event, data) {
  entering += 1;
  let r;
  try {
    r = await send(event, data);
  } finally {
    entering -= 1;
  }
  if (r.ok && r.snapshot) {
    roomStamp += 1;
    applySnapshot(r.snapshot, { fromAction: true });
  }
  replayBuffered();
  return r;
}

/** After the first hello: follow a join link (play.html?code=XXXXXX) once. */
async function maybeAutoJoin() {
  if (!joinCode || autoJoining || !socket) return;
  const code = joinCode;
  if (room?.code === code) return finishJoinLink();
  if (isLive()) {
    toast(`You're already in game ${room.code}. Leave it first to join ${code}.`);
    return finishJoinLink();
  }
  autoJoining = true;
  joining = code;
  if (room?.status === 'ended') room = null; // leave the results screen
  route();
  const r = await enterRoom('room:join', { code });
  autoJoining = false;
  joining = null;
  finishJoinLink();
  if (!r.ok) {
    joinFailure = { code, error: r.error };
    homeTab = 'play';
  }
  route();
  if (!r.ok) enterFailed(r, null);
}

function finishJoinLink() {
  joinCode = null;
  joining = null;
  session.set(JOIN_KEY, null);
  // Forget ?code= so a reload (or coming back after leaving) doesn't join again.
  const url = new URL(location.href);
  if (url.searchParams.has('code')) {
    url.searchParams.delete('code');
    history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`);
  }
}

function renderJoining() {
  clear(app).append(el('div', { class: 'card narrow center' },
    el('div', { class: 'spinner', 'aria-hidden': 'true' }),
    el('h2', {}, 'Joining game'),
    el('p', { class: 'sr-only' }, `Game code ${joining.split('').join(' ')}`),
    el('div', { class: 'code small', 'aria-hidden': 'true' }, joining.split('').map((ch) => el('span', {}, ch))),
    el('p', { class: 'muted', role: 'status' }, 'Hang tight, this only takes a moment…'),
    el('button', { class: 'ghost', onclick: () => { finishJoinLink(); route(); } }, 'Cancel')));
}

// ---------- My quizzes ----------
const quizUrl = (id) => {
  const url = new URL('play.html', location.href);
  url.search = `?quiz=${encodeURIComponent(id)}`;
  url.hash = '';
  return url.href;
};

async function quizzesTab(body) {
  clear(body).append(el('p', { class: 'muted' }, 'Loading…'));
  let quizzes;
  try {
    ({ quizzes } = await api('/api/quizzes'));
  } catch (err) {
    return loadFailed(body, err, () => quizzesTab(body));
  }
  if (!body.isConnected) return;
  clear(body).append(
    el('div', { class: 'row', style: 'margin-bottom:16px' },
      el('p', { class: 'muted grow', style: 'margin:0' }, 'Build your own quiz with any question type. Host it, or share its link so friends can host it too.'),
      el('button', { class: 'with-icon', onclick: () => quizBuilder(body, null) }, icon('plus'), 'New quiz')),
    quizzes.length
      ? el('div', { class: 'quiz-list' }, quizzes.map((q) => quizCard(body, q)))
      : el('div', { class: 'card center' },
          el('p', { class: 'muted' }, "You haven't made a quiz yet."),
          el('button', { onclick: () => quizBuilder(body, null) }, 'Make your first quiz')));
}

function quizCard(body, q) {
  const del = el('button', { class: 'ghost danger small', onclick: async () => {
    if (!(await confirmDialog({ title: `Delete “${q.title}”?`, message: "This can't be undone. Shared links to it stop working.", confirmLabel: 'Delete quiz', danger: true }))) return;
    await withPending(del, 'Deleting…', async () => {
      try {
        await api(`/api/quizzes/${q.id}`, { method: 'DELETE' });
        toast('Quiz deleted');
        quizzesTab(body);
      } catch (err) {
        toast(err.message);
      }
    });
  } }, 'Delete');
  return el('div', { class: 'card quiz-card' },
    el('div', { class: 'row' },
      el('h3', { class: 'grow', style: 'margin:0' }, q.title),
      el('span', { class: `pill${q.shared ? ' shared' : ''}` }, q.shared ? 'shared' : 'private')),
    q.description ? el('p', { class: 'muted', style: 'margin:8px 0 0' }, q.description) : null,
    el('p', { class: 'hint' }, `${q.questionCount} question${q.questionCount === 1 ? '' : 's'} · edited ${String(q.updatedAt || '').slice(0, 10)}`),
    el('div', { class: 'row quiz-actions' },
      el('button', { class: 'with-icon', onclick: () => { hostPrefs.source = 'quiz'; hostPrefs.quizId = q.id; homeTab = 'play'; renderHome(); } }, icon('play', { size: 16 }), 'Host'),
      el('button', { class: 'ghost with-icon', onclick: () => editQuiz(body, q.id) }, icon('edit', { size: 16 }), 'Edit'),
      q.shared
        ? el('button', { class: 'ghost with-icon', onclick: async () => {
            const link = quizUrl(q.id);
            toast((await copyText(link)) ? 'Share link copied' : link);
          } }, icon('link', { size: 16 }), 'Copy link')
        : null,
      el('span', { class: 'grow' }),
      del));
}

async function editQuiz(body, id) {
  clear(body).append(el('p', { class: 'muted' }, 'Loading…'));
  try {
    const { quiz } = await api(`/api/quizzes/${id}`);
    if (body.isConnected) quizBuilder(body, quiz);
  } catch (err) {
    loadFailed(body, err, () => editQuiz(body, id));
  }
}

const MAX_QUIZ_QUESTIONS = 30;

function quizBuilder(body, quiz) {
  // One id per new quiz, sent with every save: a save whose answer got lost (timeout, retried by net.js) and is sent
  // again updates the same quiz instead of creating a second copy.
  const requestId = quiz?.id ? null : randomId();
  const title = el('input', { id: 'quiz-title', maxlength: 60, value: quiz?.title || '', placeholder: 'e.g. Friday office trivia' });
  const desc = el('input', { id: 'quiz-desc', maxlength: 200, value: quiz?.description || '', placeholder: 'Optional' });
  const shared = el('input', { type: 'checkbox', checked: !!quiz?.shared });
  const list = el('div', { class: 'quiz-questions' });
  const error = el('div', { class: 'error', role: 'alert' });
  const entries = [];
  const addBtn = el('button', { type: 'button', class: 'ghost block with-icon add-question', onclick: () => add(null, true) }, icon('plus'), 'Add a question');

  function move(entry, delta) {
    const i = entries.indexOf(entry);
    const j = i + delta;
    if (j < 0 || j >= entries.length) return;
    [entries[i], entries[j]] = [entries[j], entries[i]];
    renumber();
  }
  function add(q, focus) {
    if (entries.length >= MAX_QUIZ_QUESTIONS) return toast(`A quiz can have up to ${MAX_QUIZ_QUESTIONS} questions.`);
    const ed = questionEditor(q, { withCategory: false });
    const head = el('h3', { class: 'grow', style: 'margin:0' });
    const entry = { ed, head, card: null };
    entry.card = el('div', { class: 'card qcard' },
      el('div', { class: 'row' }, head,
        el('button', { type: 'button', class: 'ghost small icon-btn', 'aria-label': 'Move up', onclick: () => move(entry, -1) }, icon('up', { size: 16 })),
        el('button', { type: 'button', class: 'ghost small icon-btn', 'aria-label': 'Move down', onclick: () => move(entry, 1) }, icon('down', { size: 16 })),
        el('button', { type: 'button', class: 'ghost danger small', onclick: () => {
          if (entries.length === 1) return toast('A quiz needs at least one question.');
          entries.splice(entries.indexOf(entry), 1);
          renumber();
        } }, 'Remove')),
      ed.node);
    entries.push(entry);
    renumber();
    if (focus) {
      entry.card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      ed.focus();
    }
  }
  function renumber() {
    placeChildren(list, entries.map((e) => e.card));
    entries.forEach((e, i) => { e.head.textContent = `Question ${i + 1}`; });
    addBtn.disabled = entries.length >= MAX_QUIZ_QUESTIONS;
  }
  (quiz?.questions?.length ? quiz.questions : [null]).forEach((q) => add(q, false));

  const save = el('button', { onclick: () => withPending(save, 'Saving…', async () => {
    error.textContent = '';
    if (title.value.trim().length < 3) {
      error.textContent = 'Give the quiz a title (at least 3 characters).';
      title.focus();
      return;
    }
    let questions;
    try {
      questions = entries.map((e, i) => {
        try {
          return e.ed.read();
        } catch (err) {
          e.card.scrollIntoView({ behavior: 'smooth', block: 'center' });
          throw new Error(`Question ${i + 1}: ${err.message}`);
        }
      });
    } catch (err) {
      error.textContent = err.message;
      return;
    }
    const payload = { title: title.value.trim(), description: desc.value.trim(), shared: shared.checked, questions };
    try {
      await api(quiz?.id ? `/api/quizzes/${quiz.id}` : '/api/quizzes', {
        method: quiz?.id ? 'PUT' : 'POST', body: quiz?.id ? payload : { ...payload, requestId },
      });
      toast('Quiz saved');
      quizzesTab(body);
    } catch (err) {
      error.textContent = err.message;
    }
  }) }, 'Save quiz');

  clear(body).append(
    el('div', { class: 'card' },
      el('h2', {}, quiz?.id ? 'Edit quiz' : 'New quiz'),
      el('label', { for: 'quiz-title' }, 'Title'), title,
      el('label', { for: 'quiz-desc' }, 'Description'), desc,
      el('label', { class: 'check-row' }, shared,
        el('span', {}, 'Let anyone with the link host this quiz', el('small', {}, "They can run it but never see the answers"))),
      el('p', { class: 'hint' }, `Up to ${MAX_QUIZ_QUESTIONS} questions. Mix the types: multiple choice, true/false, type it, put in order, closest number.`)),
    list,
    addBtn,
    el('div', { class: 'card sticky-actions' },
      error,
      el('div', { class: 'row' },
        save,
        el('button', { class: 'ghost', onclick: async () => {
          if (await confirmDialog({ title: 'Discard your changes?', message: 'Anything you changed since the last save is lost.', confirmLabel: 'Discard', cancelLabel: 'Keep editing', danger: true })) quizzesTab(body);
        } }, 'Cancel'))));
  title.focus();
}

async function leaderboardTab(body, period = 'all') {
  clear(body).append(el('p', { class: 'muted' }, 'Loading…'));
  let leaderboard;
  try {
    ({ leaderboard } = await api(`/api/leaderboard?period=${period}`));
  } catch (err) {
    return loadFailed(body, err, () => leaderboardTab(body, period));
  }
  if (!body.isConnected) return;
  clear(body).append(
    el('div', { class: 'tabs' },
      el('button', { class: period === 'all' ? 'active' : '', onclick: () => leaderboardTab(body, 'all') }, 'All time'),
      el('button', { class: period === 'week' ? 'active' : '', onclick: () => leaderboardTab(body, 'week') }, 'This week')),
    el('div', { class: 'card table-wrap' },
      leaderboard.length
        ? el('table', {},
            el('thead', {}, el('tr', {}, ...['#', 'Player', 'Points', 'Games', 'Wins'].map((h, i) => el('th', { class: i > 1 ? 'num' : '' }, h)))),
            el('tbody', {}, leaderboard.map((r) => el('tr', { class: r.userId === me?.id ? 'me-row' : '' },
              rankCell(r.rank),
              el('td', {}, r.username),
              el('td', { class: 'num' }, fmt(r.totalScore)),
              el('td', { class: 'num' }, r.gamesPlayed),
              el('td', { class: 'num' }, r.wins)))))
        : el('p', { class: 'muted' }, 'No finished games yet. Be the first on the board!')));
}

async function historyTab(body) {
  clear(body).append(el('p', { class: 'muted' }, 'Loading…'));
  let totals;
  let games;
  try {
    ({ totals, games } = await api('/api/me/history'));
  } catch (err) {
    return loadFailed(body, err, () => historyTab(body));
  }
  if (!body.isConnected) return;
  clear(body).append(
    el('div', { class: 'stats' },
      el('div', { class: 'stat' }, el('b', {}, fmt(totals.totalScore)), 'total points'),
      el('div', { class: 'stat' }, el('b', {}, totals.gamesPlayed), 'games played'),
      el('div', { class: 'stat' }, el('b', {}, totals.wins), 'wins')),
    el('div', { class: 'card table-wrap' },
      games.length
        ? el('table', {},
            el('thead', {}, el('tr', {}, ...['When', 'Category', 'Place', 'Correct', 'Points'].map((h, i) => el('th', { class: i > 1 ? 'num' : '' }, h)))),
            el('tbody', {}, games.map((g) => el('tr', {},
              el('td', {}, g.endedAt?.replace('T', ' ').slice(0, 16)),
              el('td', {}, g.category || 'All'),
              el('td', { class: 'num' }, `${g.rank} of ${g.playerCount}`),
              el('td', { class: 'num' }, `${g.correctCount}/${g.questionCount}`),
              el('td', { class: 'num' }, fmt(g.score))))))
        : el('p', { class: 'muted' }, "You haven't finished a game yet.")));
}

function loadFailed(body, err, retry) {
  if (err.status === 401) return logout({ expired: true });
  if (!body.isConnected) return;
  clear(body).append(el('div', { class: 'card' },
    el('p', { class: 'error' }, err.message),
    el('button', { class: 'ghost', onclick: retry }, 'Try again')));
}

// ---------- room ----------
/** Big-screen mode, on the host's projector. */
const isStage = () => !!room?.bigScreen && isHost() && !isPlayer();
/** "3 right in a row" mark for scoreboards. */
const streakTag = (n) => (n >= 3 ? el('span', { class: 'streak', title: `${n} right in a row` }, icon('flame', { size: 13 }), n) : null);
/** Places moved with the last question. */
const moveTag = (m) => (m
  ? el('span', { class: `move ${m > 0 ? 'up' : 'down'}`, title: m > 0 ? `Up ${m}` : `Down ${-m}` }, icon(m > 0 ? 'up' : 'down', { size: 13 }), Math.abs(m))
  : null);
const fmt = (n) => (Number(n) || 0).toLocaleString();
const isTap = (type) => !type || type === 'choice' || type === 'truefalse';
const SHAPE_NAMES = ['triangle', 'diamond', 'circle', 'square'];

function renderRoom() {
  if (room.status === 'lobby') return renderLobby();
  if (room.status === 'question' && room.question) return renderQuestion();
  if (room.status === 'reveal' && room.result) return renderReveal();
  if (room.status === 'ended') return renderEnd();
  // A phase we have no details for yet: the watchdog asks the server (sync) until a snapshot fills them in.
  clear(app).append(el('div', { class: 'card narrow center' }, el('div', { class: 'spinner', 'aria-hidden': 'true' }), el('p', { class: 'muted', role: 'status' }, 'Catching up with the game…')));
}

function leaveButton() {
  const btn = el('button', { class: 'ghost', onclick: async () => {
    if (isHost() && !(await confirmDialog({ title: 'Leave and cancel the game?', message: "You're the host: leaving cancels the game for everyone.", confirmLabel: 'Leave', danger: true }))) return;
    const code = room?.code;
    const r = await withPending(btn, 'Leaving…', () => send('room:leave'));
    if (!r) return;
    if (!r.ok) return toast(r.error);
    if (room?.code === code) {
      finished.add(code);
      room = null;
      route();
    }
  } }, 'Leave');
  return btn;
}

function cancelGameButton() {
  const btn = el('button', { class: 'ghost danger small', onclick: async () => {
    if (!(await confirmDialog({ title: 'Cancel the game?', message: 'Everyone goes back to the home screen and no scores are saved.', confirmLabel: 'Cancel game', cancelLabel: 'Keep playing', danger: true }))) return;
    const code = room?.code;
    const r = await withPending(btn, 'Cancelling…', () => send('game:cancel'));
    if (!r) return;
    if (!r.ok) return toast(r.error);
    if (room?.code === code) onGameCancelled({ code, reason: 'You cancelled the game.' });
  } }, 'Cancel game');
  return btn;
}

function fullscreenButton() {
  if (!document.fullscreenEnabled) return null;
  return el('button', { class: 'ghost small with-icon', onclick: () => {
    const p = document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
    p?.catch?.(() => {});
  } }, icon('maximize', { size: 15 }), 'Full screen');
}

function hostLine() {
  const what = room.quizTitle ? `“${room.quizTitle}”` : room.category || 'All categories';
  const mode = room.bigScreen ? ' (big screen)' : room.hostPlays ? ' (playing)' : ' (presenter)';
  return `Hosted by ${room.hostName || 'the host'}${mode} · ${room.total} questions · ${what}`;
}

/** A canvas with the QR code of `link` (null if it can't be drawn). */
function qrCanvas(link, cls) {
  const c = el('canvas', { class: cls, role: 'img', 'aria-label': 'QR code of the join link' });
  try {
    drawQr(c, link, { scale: 8 });
    return c;
  } catch {
    return null;
  }
}

const doubleBadge = () => el('div', { class: 'double-badge' }, icon('zap', { size: 14 }), 'Double points');

/** A small label with an icon (stat chips, awards, streaks). */
const chip = (iconName, ...text) => el('span', { class: 'stat-chip' }, icon(iconName, { size: 16 }), el('span', {}, ...text));

// ---------- reactions ----------
// Index = what the server counts (0-7). Each has an icon and a palette colour.
const REACTIONS = [
  { icon: 'thumbsUp', label: 'Thumbs up', tone: 'r-blue' },
  { icon: 'laugh', label: 'Haha', tone: 'r-yellow' },
  { icon: 'flame', label: 'Fire', tone: 'r-orange' },
  { icon: 'wow', label: 'Wow', tone: 'r-yellow' },
  { icon: 'party', label: 'Party', tone: 'r-green' },
  { icon: 'sad', label: 'Oh no', tone: 'r-blue' },
  { icon: 'star', label: 'Star', tone: 'r-yellow' },
  { icon: 'heart', label: 'Love', tone: 'r-red' },
];
const REACT_GAP_MS = 650;
let lastReactAt = 0;
let reactPending = REACTIONS.map(() => 0); // my own taps not yet seen in a reactions push (already floated locally)
let floating = 0;

function reactionBar() {
  return el('div', { class: 'react-bar', role: 'group', 'aria-label': 'Send a reaction' },
    REACTIONS.map((r, i) => el('button', {
      type: 'button', class: `react-btn ${r.tone}`, 'aria-label': `React: ${r.label}`, title: r.label, onclick: () => sendReaction(i),
    }, icon(r.icon, { size: 22 }))));
}

function sendReaction(i) {
  if (Date.now() - lastReactAt < REACT_GAP_MS || !room) return;
  lastReactAt = Date.now();
  floatEmoji(i, true);
  reactPending[i] += 1;
  send('react', { emoji: i }).then((r) => {
    if (!r.ok || r.sent === false) reactPending[i] = Math.max(0, reactPending[i] - 1);
  });
}

function onReactions(d) {
  const counts = Array.isArray(d.counts) ? d.counts : [];
  const queue = [];
  counts.forEach((n, i) => {
    const mine = Math.min(n || 0, reactPending[i] || 0);
    reactPending[i] -= mine;
    for (let k = 0; k < (n || 0) - mine; k++) if (REACTIONS[i]) queue.push(i);
  });
  const cap = isStage() ? 40 : 18;
  queue.sort(() => Math.random() - 0.5).slice(0, cap).forEach((e, k) => {
    setTimeout(() => floatEmoji(e, false), (k * 800) / Math.max(1, Math.min(queue.length, cap)));
  });
}

/** A reaction bubble that floats up the screen. */
function floatEmoji(i, mine) {
  const r = REACTIONS[i];
  if (!r || floating > 60 || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  floating += 1;
  const size = (isStage() ? 56 : 38) + Math.round(Math.random() * 14);
  const node = el('span', { class: `float-emoji ${r.tone}${mine ? ' mine' : ''}`, 'aria-hidden': 'true' }, icon(r.icon, { size: Math.round(size * 0.55) }));
  node.style.left = `${4 + Math.random() * 88}%`;
  node.style.setProperty('--drift', `${Math.round((Math.random() - 0.5) * 120)}px`);
  node.style.setProperty('--size', `${size}px`);
  let gone = false;
  const done = () => {
    if (gone) return;
    gone = true;
    floating -= 1;
    node.remove();
  };
  node.addEventListener('animationend', done, { once: true });
  setTimeout(done, 4000);
  document.body.append(node);
}

// ---------- lobby ----------
function renderLobby() {
  const host = isHost();
  const stage = isStage();
  const link = joinUrl(room.code, location.href);
  const linkInput = el('input', { id: 'join-link', readonly: true, value: link, class: 'mono', onfocus: (e) => e.target.select() });
  const copyBtn = el('button', { type: 'button', class: 'ghost', onclick: async () => {
    const ok = await copyText(link, linkInput);
    toast(ok ? 'Join link copied' : 'Select the link and copy it');
  } }, 'Copy link');
  const startBtn = host ? el('button', { class: stage ? 'big' : '', onclick: () => startGame(startBtn) }, 'Start game') : null;
  const ui = {
    code: room.code,
    heading: el('h3', { class: 'players-head' }),
    youIn: el('div', { class: 'banner good', hidden: true }, "You're in! Waiting for the host to start…"),
    list: el('div', { class: 'players', role: 'list' }),
    more: el('p', { class: 'muted more', hidden: true }),
    empty: el('p', { class: 'muted', hidden: true }, 'Waiting for players to join…'),
    startBtn,
    chips: new Map(),
  };
  const srCode = el('p', { class: 'sr-only' }, `Game code ${room.code.split('').join(' ')}`);
  const codeEl = el('div', { class: 'code', 'aria-hidden': 'true' }, room.code.split('').map((ch) => el('span', {}, ch)));

  if (stage) {
    const qr = qrCanvas(link, 'qr big');
    clear(app).append(
      el('div', { class: 'stage-lobby' },
        el('div', { class: 'stage-join' },
          el('p', { class: 'stage-kicker' }, 'Join on your phone at'),
          el('p', { class: 'stage-url' }, link.replace(/^https?:\/\//, '')),
          el('p', { class: 'stage-kicker' }, 'with the game code'),
          srCode, codeEl,
          el('p', { class: 'muted' }, hostLine())),
        qr ? el('div', { class: 'stage-qr' }, qr, el('p', { class: 'stage-kicker center' }, 'or scan me')) : null),
      el('div', { class: 'card' },
        ui.heading, ui.list, ui.more, ui.empty,
        el('div', { class: 'row', style: 'margin-top:16px' },
          startBtn, el('span', { class: 'grow' }), fullscreenButton(), copyBtn, leaveButton())));
  } else {
    const qr = qrCanvas(link, 'qr');
    const qrBlock = !qr ? null
      : host ? el('div', { class: 'lobby-qr' }, qr, el('p', { class: 'hint center' }, 'Scan to join'))
        : el('details', { class: 'qr-details' }, el('summary', {}, 'Show the QR code (invite someone next to you)'), qr);
    clear(app).append(el('div', { class: 'card' },
      el('p', { class: 'muted center', style: 'margin:0' }, hostLine()),
      srCode,
      el('div', { class: `lobby-top${host && qr ? ' with-qr' : ''}` }, codeEl, host ? qrBlock : null),
      el('p', { class: 'muted center' }, 'Share the code, or send this link:'),
      el('div', { class: 'join-link' }, el('label', { for: 'join-link', class: 'sr-only' }, 'Join link'), linkInput, copyBtn),
      host ? null : qrBlock,
      ui.youIn,
      ui.heading,
      ui.list,
      ui.more,
      ui.empty,
      reactionBar(),
      el('div', { class: 'row', style: 'margin-top:16px' },
        host ? startBtn : el('span', { class: 'muted grow' }, 'Waiting for the host to start…'),
        leaveButton())));
  }
  lobbyUi = ui;
  updateLobby();
}

/** Patch the lobby in place: only new players' chips animate, and the buttons are never replaced. */
function updateLobby() {
  const ui = lobbyUi;
  if (!ui || ui.code !== room?.code) return;
  const view = lobbyView(room, me.id);
  const host = isHost();
  ui.heading.textContent = isStage() ? `${view.playerCount} player${view.playerCount === 1 ? '' : 's'} in` : `Players (${view.playerCount})`;
  const nodes = view.chips.map((c) => {
    let node = ui.chips.get(c.userId);
    if (!node) {
      const chip = el('span', { class: 'player new', role: 'listitem' },
        c.username,
        c.host ? el('span', { class: 'pill' }, 'host') : null,
        c.me ? el('span', { class: 'pill' }, 'you') : null);
      chip.addEventListener('animationend', () => chip.classList.remove('new'), { once: true });
      ui.chips.set(c.userId, chip);
      node = chip;
    }
    node.classList.toggle('off', !c.connected);
    node.classList.toggle('me', c.me);
    return node;
  });
  const listed = new Set(view.chips.map((c) => c.userId));
  for (const id of ui.chips.keys()) if (!listed.has(id)) ui.chips.delete(id);
  placeChildren(ui.list, nodes);
  ui.more.hidden = view.more <= 0;
  ui.more.textContent = view.more > 0 ? `and ${view.more.toLocaleString()} more` : '';
  ui.empty.hidden = view.playerCount > 0;
  ui.youIn.hidden = host || !isPlayer();
  if (ui.startBtn && ui.startBtn.getAttribute('aria-busy') !== 'true') ui.startBtn.disabled = view.playerCount < 1;
}

/** Make `parent`'s children exactly `nodes`, moving as few as possible. */
function placeChildren(parent, nodes) {
  let cursor = parent.firstChild;
  for (const node of nodes) {
    if (node === cursor) {
      cursor = cursor.nextSibling;
      continue;
    }
    parent.insertBefore(node, cursor);
  }
  while (cursor) {
    const next = cursor.nextSibling;
    cursor.remove();
    cursor = next;
  }
}

async function startGame(btn) {
  const code = room?.code;
  const r = await withPending(btn, 'Starting…', () => send('game:start'));
  if (!r) return;
  if (!r.ok) return toast(r.error);
  // The first question arrives as a push; if it got lost, don't wait for the lobby watchdog.
  setTimeout(() => { if (room?.code === code && room.status === 'lobby') sync(); }, 3000);
}

// ---------- question ----------
function startCountdown(endsAt, totalMs, bar, label, onDone) {
  clearInterval(tick);
  let done = false;
  const update = () => {
    const left = Math.max(0, endsAt - serverNow());
    if (bar) bar.style.transform = `scaleX(${totalMs > 0 ? Math.min(1, left / totalMs) : 0})`;
    label.textContent = `${Math.ceil(left / 1000)}s`;
    label.classList.toggle('hurry', totalMs > 0 && left > 0 && left <= 5000);
    if (left <= 0 && !done) {
      done = true;
      clearInterval(tick);
      onDone?.();
    }
  };
  update();
  tick = setInterval(update, 100);
}

/**
 * Only the site's own flag pictures ("/flags/<name>.svg", same rule as the server's lib/images.js). Anything else,
 * including other hosts ("https://...", "//host", "/\host"), javascript: and data:, is dropped: a quiz author must
 * never be able to make players' browsers call a server of their choosing.
 */
function safeImageUrl(raw) {
  const src = String(raw || '').trim();
  if (!/^\/flags\/[A-Za-z0-9_-]{1,40}\.svg$/.test(src)) return null;
  try {
    const url = new URL(src, location.href);
    return url.origin === location.origin ? url.href : null;
  } catch {
    return null;
  }
}

function renderQuestionContent(rawText) {
  rawText = typeof rawText === 'string' ? rawText : '';
  const match = rawText.match(/\[image:([^\]]+)\]/);
  const src = match ? safeImageUrl(match[1]) : null;
  if (!match) return el('div', { class: 'qtext', tabindex: '-1' }, rawText);
  if (!src) return el('div', { class: 'qtext', tabindex: '-1' }, rawText.replace(/\[image:[^\]]+\]/, '').trim());
  const cleanText = rawText.replace(/\[image:[^\]]+\]/, '').trim();
  return el('div', { class: 'qcontent', tabindex: '-1' },
    cleanText ? el('div', { class: 'qtext' }, cleanText) : null,
    el('div', { class: 'qimage-wrap' }, el('img', { src, referrerpolicy: 'no-referrer', alt: 'Question image', class: 'qimage' })));
}

const answerKey = (code, index) => `${code}:${index}`;

function rememberAnswer(code, index, choice, shown) {
  session.set(ANSWER_KEY, choice == null && shown == null ? null : JSON.stringify({ code, index, choice, shown }));
}

/** The server says we already answered this question (e.g. after a reload): show it as locked in. */
function markAnswered(code, index) {
  const key = answerKey(code, index);
  if (answer?.key === key && answer.state !== 'sending') return;
  let choice = answer?.key === key ? answer.choice : null;
  let shown = answer?.key === key ? answer.shown : null;
  if (choice == null && shown == null) {
    try {
      const saved = JSON.parse(session.get(ANSWER_KEY) || 'null');
      if (saved?.code === code && saved.index === index) ({ choice = null, shown = null } = saved);
    } catch { /* ignore */ }
  }
  answer = { key, choice, shown, state: 'locked' };
}

/** A tap button for option i (shape-only on a big-screen answer pad). */
/**
 * A tap button for option i. In big-screen mode (projector and phones alike) each option also carries its shape, so
 * people can match their phone to the big screen at a glance.
 */
function optionButton(q, text, i, { shaped = false } = {}) {
  const tf = q.type === 'truefalse';
  const withShape = shaped && !tf;
  return el('button', {
    class: `opt${tf ? ' tf' : ''}${withShape ? ' shaped' : ''}`, 'aria-pressed': 'false',
    'aria-label': withShape ? `${text} (${SHAPE_NAMES[i]})` : null,
    onclick: () => pick(i),
  },
  withShape ? shape(i) : null,
  el('span', { class: 'opt-text' }, text));
}

function typedInput() {
  const input = el('input', {
    class: 'answer-input', maxlength: 60, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false',
    placeholder: 'Type your answer…', 'aria-label': 'Your answer', enterkeyhint: 'send',
  });
  const btn = el('button', { type: 'submit' }, 'Submit');
  const node = el('form', { class: 'answer-form', onsubmit: (e) => {
    e.preventDefault();
    const v = input.value.trim();
    if (v) submitAnswer({ text: v }, v);
  } }, input, btn);
  return { node, focus: () => input.focus(), setDisabled: (d) => { input.disabled = d; btn.disabled = d; } };
}

function numberInput(q) {
  const input = el('input', {
    class: 'answer-input', type: 'number', step: 'any', inputmode: 'decimal', placeholder: 'Your guess', 'aria-label': 'Your guess', enterkeyhint: 'send',
  });
  const btn = el('button', { type: 'submit' }, 'Guess');
  const node = el('form', { class: 'answer-form', onsubmit: (e) => {
    e.preventDefault();
    const v = Number(input.value);
    if (input.value.trim() !== '' && Number.isFinite(v)) submitAnswer({ value: v }, `${v}${q.unit ? ` ${q.unit}` : ''}`);
  } }, input, q.unit ? el('span', { class: 'unit' }, q.unit) : null, btn);
  return { node, focus: () => input.focus(), setDisabled: (d) => { input.disabled = d; btn.disabled = d; } };
}

/** Tap the items in order: 1st, 2nd, ... Tapping a placed item takes it (and everything after it) back. */
function orderInput(q) {
  const picked = [];
  let disabled = false;
  const n = q.options.length;
  const items = (q.options || []).map((text, i) => el('button', { type: 'button', class: 'order-item', onclick: () => toggle(i) },
    el('span', { class: 'order-slot', 'aria-hidden': 'true' }), el('span', {}, text)));
  const submit = el('button', { type: 'button', class: 'block', onclick: () => {
    if (picked.length === n) submitAnswer({ order: [...picked] }, picked.map((i) => q.options[i]).join(' → '));
  } }, 'Lock in this order');
  const reset = el('button', { type: 'button', class: 'ghost small', onclick: () => { picked.length = 0; paint(); } }, 'Start over');
  function toggle(i) {
    if (disabled) return;
    const at = picked.indexOf(i);
    if (at >= 0) picked.splice(at);
    else picked.push(i);
    if (picked.length === n - 1) picked.push(q.options.findIndex((_, k) => !picked.includes(k))); // the last one places itself
    paint();
  }
  function paint() {
    items.forEach((b, i) => {
      const p = picked.indexOf(i);
      b.querySelector('.order-slot').textContent = p >= 0 ? String(p + 1) : '';
      b.classList.toggle('placed', p >= 0);
      b.setAttribute('aria-label', `${q.options[i]}${p >= 0 ? `, position ${p + 1}` : ''}`);
      b.disabled = disabled;
    });
    submit.disabled = disabled || picked.length !== n;
    reset.disabled = disabled || !picked.length;
  }
  paint();
  const node = el('div', { class: 'order-input' },
    el('p', { class: 'hint' }, 'Tap the items from first to last.'),
    el('div', { class: 'order-list' }, items),
    el('div', { class: 'row', style: 'justify-content:flex-end' }, reset),
    submit);
  return { node, focus: () => {}, setDisabled: (d) => { disabled = d; paint(); } };
}

/** What a presenter (or the big screen) shows instead of inputs for the non-tap types. */
function presenterBox(q) {
  if (q.type === 'order') {
    return el('div', {},
      el('p', { class: 'reveal-label' }, 'Put these in order'),
      el('ul', { class: 'order-show' }, (q.options || []).map((t) => el('li', {}, t))));
  }
  return el('div', { class: 'type-wait' },
    icon(q.type === 'number' ? 'number' : 'type', { size: 28 }),
    el('span', {}, q.type === 'number' ? `Guess the number${q.unit ? ` (${q.unit})` : ''} on your phone` : 'Type your answer on your phone'));
}

function renderQuestion() {
  const q = room.question;
  const type = q.type || 'choice';
  const tap = isTap(type);
  const key = answerKey(room.code, q.index);
  if (answer?.key !== key) answer = null;
  const playing = isPlayer();
  const stage = isStage();
  const shaped = !!room.bigScreen;
  const bar = el('i');
  const timeLabel = el('span', { class: 'timer', 'aria-hidden': 'true' });
  const status = el('div', { class: 'banner info', role: 'status', hidden: true });
  const count = el('span', { class: 'muted' });
  const options = tap ? (q.options || []).map((text, i) => optionButton(q, text, i, { shaped })) : [];
  let input = null;
  if (!tap && playing) input = type === 'type' ? typedInput(q) : type === 'number' ? numberInput(q) : orderInput(q);
  questionUi = { key, type, tap, playing, options, input, status, count, timeUp: false };

  const answersEl = tap
    ? el('div', { class: `opts${type === 'truefalse' ? ' two' : ''}${stage ? ' stage-opts' : ''}`, role: 'group', 'aria-label': 'Answers' }, options)
    : input ? input.node : presenterBox(q);
  let content;
  if (stage) {
    clear(app).append(el('div', { class: 'stage-q' },
      el('div', { class: 'stage-qhead' },
        el('span', {}, `Question ${q.index + 1} of ${q.total ?? room.total}`),
        q.double ? doubleBadge() : null,
        count),
      el('div', { class: 'bar big', 'aria-hidden': 'true' }, bar),
      el('div', { class: 'stage-qmain' },
        (content = renderQuestionContent(q.text)),
        el('div', { class: 'stage-timer' }, timeLabel)),
      answersEl,
      el('div', { class: 'row', style: 'justify-content:flex-end;margin-top:20px' }, fullscreenButton(), cancelGameButton())));
  } else {
    content = renderQuestionContent(q.text);
    clear(app).append(el('div', { class: 'card' },
      el('div', { class: 'qhead' },
        el('span', {}, `Question ${q.index + 1} of ${q.total ?? room.total}`),
        count,
        timeLabel),
      el('div', { class: 'bar', 'aria-hidden': 'true' }, bar),
      q.double ? doubleBadge() : null,
      content,
      status,
      answersEl,
      playing && tap ? el('p', { class: 'hint center hide-touch' }, `Tip: press 1-${options.length} to answer`) : null,
      isHost() ? el('div', { class: 'row', style: 'margin-top:16px;justify-content:flex-end' }, cancelGameButton()) : null));
  }
  paintQuestion();
  if (document.hasFocus() && (!document.activeElement || document.activeElement === document.body || app.contains(document.activeElement))) {
    if (input && !answer) input.focus();
    else content.focus({ preventScroll: true });
  }
  startCountdown(q.endsAt, (q.timeLimit || 0) * 1000, bar, timeLabel, () => {
    if (questionUi?.key !== key) return;
    questionUi.timeUp = true;
    paintQuestion();
  });
}

function paintAnswerCount() {
  if (!questionUi || !room?.answerCount) return;
  const c = room.answerCount;
  questionUi.count.textContent = `${c.answered} / ${c.total ?? room.playerCount ?? '?'} answered`;
}

function paintQuestion() {
  const ui = questionUi;
  if (!ui || answerKey(room?.code, room?.question?.index) !== ui.key) return;
  paintAnswerCount();
  const mine = answer?.key === ui.key ? answer : null;
  ui.options.forEach((b, i) => {
    const picked = !!mine && mine.choice === i;
    b.disabled = !ui.playing || !!mine || ui.timeUp;
    b.classList.toggle('picked', picked);
    b.classList.toggle('sending', picked && mine.state === 'sending');
    b.setAttribute('aria-pressed', String(picked));
  });
  ui.input?.setDisabled(!ui.playing || !!mine || ui.timeUp);
  let text = '';
  let tone = 'info';
  if (!ui.playing) text = ui.tap ? 'Presenter mode · Answers are hidden on this screen' : 'Presenter mode · Players answer on their phones';
  else if (mine?.state === 'sending') text = 'Sending your answer…';
  else if (mine?.state === 'locked') text = !ui.tap && mine.shown ? `Locked in: ${mine.shown}. Waiting for the others…` : 'Answer locked in. Waiting for the others…';
  else if (mine?.state === 'closed') { text = mine.note; tone = 'bad'; }
  else if (ui.timeUp) text = "Time's up! Waiting for the results…";
  ui.status.hidden = !text;
  ui.status.textContent = text;
  ui.status.className = `banner ${tone}`;
}

function pick(choice) {
  const q = room?.question;
  submitAnswer({ choice }, q?.options?.[choice] ?? null);
}

/** Sends an answer of any type ({choice} / {text} / {order} / {value}); `shown` is how it reads on screen. */
async function submitAnswer(payload, shown) {
  const ui = questionUi;
  if (!ui || !ui.playing || ui.timeUp || answer?.key === ui.key) return;
  const { code } = room;
  const { index } = room.question;
  const choice = payload.choice ?? null;
  answer = { key: ui.key, choice, shown, state: 'sending' };
  rememberAnswer(code, index, choice, shown);
  paintQuestion();
  const r = await send('answer:submit', { code, index, ...payload });
  if (answer?.key !== ui.key || answer.state !== 'sending') return; // moved on, or a snapshot settled it
  if (r.ok) answer.state = 'locked';
  else if (isFinalAnswerError(r.error)) answer = { key: ui.key, choice: null, shown: null, state: 'closed', note: r.error };
  else {
    // Retryable (busy server, lost connection): let the player try again.
    answer = null;
    rememberAnswer(code, index, null, null);
    toast(r.error || "Couldn't send your answer. Try again.");
  }
  paintQuestion();
}

function answerHotkey(e) {
  if (!questionUi || !questionUi.tap || e.altKey || e.ctrlKey || e.metaKey || e.target?.closest?.('input, textarea, select')) return;
  const i = '1234'.indexOf(e.key);
  if (i >= 0 && i < questionUi.options.length && !questionUi.options[i].disabled) {
    e.preventDefault();
    pick(i);
  }
}

// ---------- reveal ----------
/** How my answer reads (non-tap types). */
function formatMine(r, ans) {
  if (ans == null) return '';
  if (r.type === 'order' && Array.isArray(ans)) return ans.map((i) => r.options?.[i] ?? '?').join(' → ');
  if (r.type === 'number') return `${ans}${r.unit ? ` ${r.unit}` : ''}`;
  return String(ans);
}

function revealBanner(r, mine, playing) {
  const banner = (tone, iconName, ...text) => el('div', { class: `banner ${tone} with-icon`, role: 'status' }, icon(iconName, { size: 20 }), el('span', { class: 'grow' }, ...text));
  if (!playing) return banner('info', 'chart', 'Results for this question');
  if (!mine) return banner('bad', 'clock', "Time's up. You didn't answer.");
  const streak = mine.bonus ? el('span', { class: 'streak-pill' }, icon('flame', { size: 14 }), `${mine.streak} in a row · +${fmt(mine.bonus)}`) : null;
  const doubled = r.double ? ' (double points)' : '';
  if (mine.correct) return banner('good', 'checkCircle', `Correct! +${fmt(mine.gained)} points${doubled}`, streak);
  if (mine.partial) return banner('warn', 'rise', `So close! +${fmt(mine.gained)} points${doubled}`);
  return banner('bad', 'xCircle', 'Not quite.');
}

/** The right answer, and how the room answered. */
function revealAnswer(r, mine, { big = false } = {}) {
  const type = r.type || 'choice';
  const shaped = big || !!room?.bigScreen;
  if (isTap(type)) {
    const counts = r.optionCounts || [];
    const answered = r.answeredCount ?? counts.reduce((s, n) => s + (n || 0), 0);
    const opts = (r.options || []).map((text, i) => {
      const n = counts[i] || 0;
      const share = answered > 0 ? n / answered : 0;
      const label = `${n} ${n === 1 ? 'answer' : 'answers'}`;
      return el('button', {
        class: `opt reveal${type === 'truefalse' ? ' tf' : ''}${i === r.correctIndex ? ' correct' : ' dim'}${mine?.choice === i ? ' picked' : ''}`,
        disabled: true,
        'aria-label': `${text}${i === r.correctIndex ? ' (correct)' : ''}${mine?.choice === i ? ' (your answer)' : ''}, ${label}`,
      },
      shaped && type !== 'truefalse' ? shape(i) : null,
      el('span', { class: 'opt-text' }, text),
      el('span', { class: 'opt-count', title: label }, n.toLocaleString()),
      el('i', { class: 'opt-share', style: `transform:scaleX(${share})`, 'aria-hidden': 'true' }));
    });
    return el('div', { class: `opts${type === 'truefalse' ? ' two' : ''}${big ? ' stage-opts' : ''}` }, opts);
  }
  const yours = mine && mine.answer != null
    ? el('p', { class: 'your-answer' }, 'Your answer: ', el('b', {}, formatMine(r, mine.answer)))
    : null;
  const s = r.summary || {};
  if (type === 'order') {
    return el('div', { class: 'reveal-box' },
      el('p', { class: 'reveal-label' }, 'The right order'),
      el('ol', { class: 'order-show correct' }, (r.correctOrder || []).map((i) => el('li', {}, r.options?.[i] ?? ''))),
      yours,
      s.perfect != null ? el('p', { class: 'muted' }, `${fmt(s.perfect)} got it perfect`) : null);
  }
  if (type === 'type') {
    const guesses = s.guesses || [];
    return el('div', { class: 'reveal-box' },
      el('p', { class: 'reveal-label' }, 'Answer'),
      el('p', { class: 'reveal-answer' }, r.answerText),
      yours,
      guesses.length
        ? el('div', { class: 'guesses' },
            el('p', { class: 'reveal-label' }, 'What people typed'),
            el('ul', {}, guesses.map((g) => el('li', { class: g.correct ? 'right' : 'wrong' },
              el('span', { class: 'with-icon' }, icon(g.correct ? 'check' : 'x', { size: 16 }), g.text), el('b', {}, fmt(g.count))))))
        : null);
  }
  return el('div', { class: 'reveal-box' },
    el('p', { class: 'reveal-label' }, 'Answer'),
    el('p', { class: 'reveal-answer' }, r.answerText),
    yours);
}

/** Fun facts about the question: how many got it, the fastest, the biggest climber, the closest guess. */
function statChips(r) {
  const chips = [];
  const b = (t) => el('b', {}, t);
  if (r.rightCount != null && r.answeredCount > 0) chips.push(chip('checkCircle', b(`${fmt(r.rightCount)} of ${fmt(r.answeredCount)}`), ' got it right'));
  if (r.fastest) chips.push(chip('zap', 'Fastest ', b(r.fastest.username), ` ${(r.fastest.ms / 1000).toFixed(1)}s`));
  if (r.summary?.closest) chips.push(chip('number', 'Closest ', b(r.summary.closest.username), ` ${r.summary.closest.value}${r.unit ? ` ${r.unit}` : ''}`));
  if (r.summary?.average != null) chips.push(chip('chart', 'Average guess ', b(r.summary.average)));
  if (r.climber) chips.push(chip('rise', b(r.climber.username), ` climbed ${r.climber.move} place${r.climber.move === 1 ? '' : 's'}`));
  return chips.length ? el('div', { class: 'stat-chips' }, chips) : null;
}

function renderReveal() {
  const r = room.result;
  if (isStage()) return renderStageReveal(r);
  const playing = isPlayer();
  const mine = r.myChoice || null;
  const last = r.index + 1 >= (r.total ?? room.total);
  const nextLabel = el('span', { class: 'timer' });
  const qhead = el('div', { class: 'qhead' },
    el('span', {}, `Question ${r.index + 1} of ${r.total ?? room.total}`),
    el('span', {}, last ? 'Final results in ' : 'Next question in ', nextLabel));

  // Phones get the full result in every mode (big-screen too): the answer, the facts and the scoreboard.
  const answered = r.answeredCount ?? 0;
  clear(app).append(el('div', { class: 'card' },
    qhead,
    r.double ? doubleBadge() : null,
    renderQuestionContent(r.text || ''),
    revealBanner(r, mine, playing),
    revealAnswer(r, mine),
    statChips(r),
    el('p', { class: 'muted answered-line' }, `${answered.toLocaleString()} of ${(r.playerCount ?? room.playerCount ?? answered).toLocaleString()} answered`),
    el('h3', { style: 'margin-top:20px' }, 'Scoreboard'),
    boardTable(r.leaderboard || [], r.me, true),
    reactionBar(),
    isHost() ? el('div', { class: 'row', style: 'margin-top:16px;justify-content:flex-end' }, cancelGameButton()) : null));
  if (typeof r.revealEndsAt === 'number') startCountdown(r.revealEndsAt, 0, null, nextLabel);
  else nextLabel.textContent = 'a moment';
}

function renderStageReveal(r) {
  const last = r.index + 1 >= (r.total ?? room.total);
  const nextLabel = el('span', { class: 'timer' });
  clear(app).append(el('div', { class: 'stage-reveal' },
    el('div', { class: 'stage-qhead' },
      el('span', {}, `Question ${r.index + 1} of ${r.total ?? room.total}`),
      r.double ? doubleBadge() : null,
      el('span', {}, last ? 'Final results in ' : 'Next question in ', nextLabel)),
    el('div', { class: 'stage-cols' },
      el('div', {},
        renderQuestionContent(r.text || ''),
        revealAnswer(r, null, { big: true }),
        statChips(r)),
      el('div', { class: 'card stage-board' },
        el('h3', {}, 'Leaderboard'),
        animatedBoard((r.leaderboard || []).slice(0, 5)))),
    el('div', { class: 'row', style: 'justify-content:flex-end;margin-top:20px' }, fullscreenButton(), cancelGameButton())));
  if (typeof r.revealEndsAt === 'number') startCountdown(r.revealEndsAt, 0, null, nextLabel);
  else nextLabel.textContent = 'a moment';
}

/** Rows slide from where they were before this question to where they are now, and scores count up. */
function animatedBoard(rows) {
  if (!rows.length) return el('p', { class: 'muted' }, 'No scores yet.');
  const ROW = 64; // px: .anim-row height + gap
  const scores = [];
  const list = el('ol', { class: 'anim-board' }, rows.map((p, i) => {
    const score = el('b', { class: 'anim-score' }, fmt(p.score - (p.lastGain || 0)));
    scores.push([score, p.score - (p.lastGain || 0), p.score]);
    const li = el('li', { class: 'anim-row' },
      el('span', { class: 'rk' }, p.rank),
      el('span', { class: 'name' }, p.username, streakTag(p.streak)),
      moveTag(p.move),
      p.lastGain ? el('span', { class: 'gain' }, `+${fmt(p.lastGain)}`) : null,
      score);
    const from = p.move > 0 ? Math.min(p.move, rows.length - i) : Math.max(p.move || 0, -i);
    li.style.transform = `translateY(${from * ROW}px)`;
    return li;
  }));
  requestAnimationFrame(() => requestAnimationFrame(() => {
    for (const li of list.children) {
      li.classList.add('go');
      li.style.transform = '';
    }
    for (const [node, from, to] of scores) countUp(node, from, to, 900);
  }));
  return list;
}

function countUp(node, from, to, ms) {
  if (from === to || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    node.textContent = fmt(to);
    return;
  }
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / ms);
    node.textContent = fmt(Math.round(from + (to - from) * (1 - (1 - t) ** 3)));
    if (t < 1 && node.isConnected) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** Top 10, plus my own row under a gap when I'm further down. */
function boardTable(rows, meRow, showGain) {
  const { top, me: extra } = splitBoard(rows, meRow);
  const row = (p, cls = '') => el('tr', { class: `${cls}${p.userId === me.id ? ' me-row' : ''}`.trim() },
    rankCell(p.rank),
    el('td', {}, p.username,
      p.userId === me.id ? el('span', { class: 'pill', style: 'margin-left:6px' }, 'you') : null,
      streakTag(p.streak),
      showGain ? moveTag(p.move) : null),
    el('td', { class: 'num' }, (p.score ?? 0).toLocaleString(),
      showGain && p.lastGain ? el('span', { class: 'gain' }, `+${p.lastGain.toLocaleString()}`) : null));
  if (!top.length) return el('p', { class: 'muted' }, 'No scores yet.');
  return el('div', { class: 'table-wrap' }, el('table', { class: 'board' },
    el('tbody', {},
      top.map((p) => row(p)),
      extra ? [el('tr', { class: 'gap', 'aria-hidden': 'true' }, el('td', { colspan: 3 }, '⋯')), row(extra)] : null)));
}

// ---------- end ----------
function podiumView(rows) {
  const top = rows.slice(0, 3);
  if (!top.length) return null;
  return el('div', { class: 'podium', role: 'list', 'aria-label': 'Top three' }, [1, 0, 2].filter((i) => top[i]).map((i) => {
    const p = top[i];
    return el('div', { class: `podium-step p${i + 1}`, role: 'listitem' },
      el('div', { class: 'podium-name' }, p.username),
      el('div', { class: 'podium-score' }, `${fmt(p.score)} pts`),
      el('div', { class: 'podium-block' }, el('span', { class: 'podium-rank' }, medal(p.rank))));
  }));
}

function awardChips(a) {
  const chips = [];
  if (a?.streak) chips.push(chip('flame', 'Longest streak ', el('b', {}, a.streak.username), ` ${a.streak.n} in a row`));
  if (a?.sharp) chips.push(chip('award', 'Most right answers ', el('b', {}, a.sharp.username), ` ${a.sharp.n}`));
  return chips.length ? el('div', { class: 'stat-chips center' }, chips) : null;
}

function renderEnd() {
  const f = room.final || {};
  const rows = f.leaderboard || [];
  const mine = f.me || rows.find((p) => p.userId === me.id) || null;
  const players = f.playerCount ?? room.playerCount;
  const stage = isStage();
  clear(app).append(el('div', { class: `card${stage ? ' stage-end' : ''}` },
    el('h2', { class: 'center' }, 'Game over!'),
    mine
      ? el('p', { class: 'finish-line center', role: 'status' },
          `You finished ${medal(mine.rank)}${players ? ` of ${players.toLocaleString()}` : ''} with ${(mine.score ?? 0).toLocaleString()} points (${mine.correctCount ?? 0} correct).`)
      : null,
    podiumView(rows),
    awardChips(f.awards),
    rows.length ? boardTable(rows, mine, false) : el('p', { class: 'muted' }, 'No players.'),
    stage ? null : reactionBar(),
    el('div', { class: 'row', style: 'margin-top:16px' },
      el('button', { onclick: () => { room = null; homeTab = 'leaderboard'; route(); } }, 'See leaderboard'),
      el('button', { class: 'ghost', onclick: () => { room = null; homeTab = 'play'; route(); } }, 'Back to home'),
      stage ? fullscreenButton() : null)));
}

boot();
