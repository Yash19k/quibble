import {
  api, el, clear, toast, medal, rankCell, sleep, WS_URL, session, setNotice, withPending, copyText,
  getToken, setToken, getProfile, setProfile, getLastEmail, setLastEmail,
  randomId, decodeJwt, tokenExpired, parseJoinCode, joinUrl, splitBoard, lobbyView, isStale, isFinalAnswerError,
} from './common.js';
import { Realtime } from './realtime.js';

// Game protocol spoken with the server. The server answers hello with {reload: true} when it moved on.
const PROTOCOL = 2;
const JOIN_KEY = 'quibble.join'; // join-link code, kept through login / sign-up (and reloads)
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
  if (!expired && isLive() && !confirm("You're in a game. Log out anyway?")) return;
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
const SETTLED_FIELDS = ['hostId', 'hostName', 'hostPlays', 'category', 'total', 'isPlayer'];
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
};

function onPush(event, data) {
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
  for (const k of ['hostId', 'hostName', 'hostPlays', 'category', 'total', 'playerCount', 'players']) {
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
  const password = el('input', { id: 'auth-password', type: 'password', autocomplete: register ? 'new-password' : 'current-password', minlength: register ? 8 : 1, maxlength: 100, required: true });
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
    ...[['play', 'Play'], ['leaderboard', 'Leaderboard'], ['history', 'My games']].map(([id, label]) =>
      el('button', {
        role: 'tab', 'aria-selected': String(homeTab === id), class: homeTab === id ? 'active' : '',
        onclick: () => { homeTab = id; renderHome(); },
      }, label)));
  const body = el('div', { role: 'tabpanel' });
  clear(app).append(tabs, body);
  if (homeTab === 'play') playTab(body);
  if (homeTab === 'leaderboard') leaderboardTab(body);
  if (homeTab === 'history') historyTab(body);
}

async function loadCategories() {
  if (categoriesCache && Date.now() - categoriesCache.at < 60_000) return categoriesCache.list;
  const { categories } = await api('/api/categories');
  categoriesCache = { at: Date.now(), list: categories };
  return categories;
}

function playTab(body) {
  const selectedCats = new Set(); // empty = all categories
  let catCounts = new Map();
  const catGrid = el('div', { class: 'cat-grid', role: 'group', 'aria-label': 'Categories' }, el('p', { class: 'muted' }, 'Loading categories…'));
  const catHint = el('p', { class: 'muted cat-hint' });
  const count = el('input', { id: 'q-count', type: 'number', min: 1, max: 30, value: 10 });
  const hostPlays = el('input', { type: 'checkbox', id: 'host-plays', checked: true });
  const createErr = el('div', { class: 'error', role: 'alert' });
  const failed = joinFailure;
  joinFailure = null;
  const code = el('input', {
    id: 'join-code', maxlength: 6, placeholder: 'ABC123', autocapitalize: 'characters', autocomplete: 'off', spellcheck: 'false',
    class: 'code-input', value: failed?.code || '', 'aria-describedby': 'join-err',
  });
  const joinErr = el('div', { class: 'error', id: 'join-err', role: 'alert' }, failed?.error || '');

  // "All" clears the selection; any other box toggles in or out (pick as many as you like).
  function toggleCat(value) {
    if (!value) selectedCats.clear();
    else if (selectedCats.has(value)) selectedCats.delete(value);
    else selectedCats.add(value);
    catGrid.querySelectorAll('.cat-box').forEach((b) => {
      const on = b.dataset.cat ? selectedCats.has(b.dataset.cat) : selectedCats.size === 0;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    });
    const pool = selectedCats.size
      ? [...selectedCats].reduce((s, c) => s + (catCounts.get(c) || 0), 0)
      : [...catCounts.values()].reduce((s, n) => s + n, 0);
    catHint.textContent = selectedCats.size
      ? `${selectedCats.size} selected · ${pool} questions available`
      : `All categories · ${pool} questions available`;
  }

  const createBtn = el('button', { class: 'block', onclick: () => createGame(createBtn, createErr, {
    categories: [...selectedCats],
    count: Math.min(30, Math.max(1, Number(count.value) || 10)),
    hostPlays: hostPlays.checked,
  }) }, 'Create game');
  const joinBtn = el('button', { class: 'block', type: 'submit' }, 'Join');
  const joinForm = el('form', { class: 'card', onsubmit: (e) => { e.preventDefault(); joinGame(code.value, joinBtn, joinErr); } },
    el('h3', {}, 'Join a game'),
    el('p', { class: 'muted' }, 'Enter the 6-character code from the host, or open their join link.'),
    el('label', { for: 'join-code' }, 'Game code'), code,
    joinErr,
    joinBtn);

  body.append(el('div', { class: 'grid2' },
    el('div', { class: 'card' },
      el('h3', {}, 'Host a game'),
      el('p', { class: 'muted' }, 'Create a room with a 6-character code. Play along or host for others.'),
      el('label', {}, 'Categories (pick one or more)'), catGrid, catHint,
      el('label', { for: 'q-count' }, 'Number of questions'), count,
      el('label', { class: 'check-row' }, hostPlays, el('span', {}, 'Participate as a player')),
      createErr,
      createBtn),
    joinForm));
  if (failed) code.focus();

  loadCategories().then((categories) => {
    catCounts = new Map(categories.map((c) => [c.category, c.count]));
    clear(catGrid).append(
      el('button', { type: 'button', class: 'cat-box', 'data-cat': '', onclick: () => toggleCat('') },
        'All', el('span', { class: 'cat-count' }, `(${categories.reduce((s, c) => s + c.count, 0)})`)),
      ...categories.map((c) => el('button', { type: 'button', class: 'cat-box', 'data-cat': c.category, onclick: () => toggleCat(c.category) },
        c.category, el('span', { class: 'cat-count' }, `(${c.count})`))));
    toggleCat(''); // start on "All"
    if (!categories.length) createErr.textContent = 'No questions yet. An admin needs to add some (or run npm run seed).';
  }).catch((err) => {
    clear(catGrid).append(el('p', { class: 'muted' }, "Couldn't load the categories. All categories will be used."));
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
              el('td', { class: 'num' }, r.totalScore.toLocaleString()),
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
      el('div', { class: 'stat' }, el('b', {}, totals.totalScore.toLocaleString()), 'total points'),
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
              el('td', { class: 'num' }, g.score.toLocaleString())))))
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
    if (isHost() && !confirm('Leaving cancels the game for everyone. Leave anyway?')) return;
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
    if (!confirm('Are you sure you want to cancel the game?')) return;
    const code = room?.code;
    const r = await withPending(btn, 'Cancelling…', () => send('game:cancel'));
    if (!r) return;
    if (!r.ok) return toast(r.error);
    if (room?.code === code) onGameCancelled({ code, reason: 'You cancelled the game.' });
  } }, 'Cancel game');
  return btn;
}

function hostLine() {
  return `Hosted by ${room.hostName || 'the host'}${room.hostPlays ? ' (playing)' : ' (presenter)'} · ${room.total} questions · ${room.category || 'All categories'}`;
}

function renderLobby() {
  const host = isHost();
  const link = joinUrl(room.code, location.href);
  const linkInput = el('input', { id: 'join-link', readonly: true, value: link, class: 'mono', onfocus: (e) => e.target.select() });
  const copyBtn = el('button', { type: 'button', class: 'ghost', onclick: async () => {
    const ok = await copyText(link, linkInput);
    toast(ok ? 'Join link copied' : 'Select the link and copy it');
  } }, 'Copy link');
  const startBtn = host ? el('button', { onclick: () => startGame(startBtn) }, 'Start game') : null;
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
  clear(app).append(el('div', { class: 'card' },
    el('p', { class: 'muted center', style: 'margin:0' }, hostLine()),
    el('p', { class: 'sr-only' }, `Game code ${room.code.split('').join(' ')}`),
    el('div', { class: 'code', 'aria-hidden': 'true' }, room.code.split('').map((ch) => el('span', {}, ch))),
    el('p', { class: 'muted center' }, 'Share the code, or send this link:'),
    el('div', { class: 'join-link' }, el('label', { for: 'join-link', class: 'sr-only' }, 'Join link'), linkInput, copyBtn),
    ui.youIn,
    ui.heading,
    ui.list,
    ui.more,
    ui.empty,
    el('div', { class: 'row', style: 'margin-top:16px' },
      host ? startBtn : el('span', { class: 'muted grow' }, 'Waiting for the host to start…'),
      leaveButton())));
  lobbyUi = ui;
  updateLobby();
}

/** Patch the lobby in place: only new players' chips animate, and the buttons are never replaced. */
function updateLobby() {
  const ui = lobbyUi;
  if (!ui || ui.code !== room?.code) return;
  const view = lobbyView(room, me.id);
  const host = isHost();
  ui.heading.textContent = `Players (${view.playerCount})`;
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
    if (left <= 0 && !done) {
      done = true;
      clearInterval(tick);
      onDone?.();
    }
  };
  update();
  tick = setInterval(update, 100);
}

function renderQuestionContent(rawText) {
  const match = rawText.match(/\[image:([^\]]+)\]/);
  if (!match) return el('div', { class: 'qtext', tabindex: '-1' }, rawText);
  const cleanText = rawText.replace(/\[image:[^\]]+\]/, '').trim();
  return el('div', { class: 'qcontent', tabindex: '-1' },
    cleanText ? el('div', { class: 'qtext' }, cleanText) : null,
    el('div', { class: 'qimage-wrap' }, el('img', { src: match[1], alt: 'Question image', class: 'qimage' })));
}

const answerKey = (code, index) => `${code}:${index}`;

function rememberAnswer(code, index, choice) {
  session.set(ANSWER_KEY, choice == null ? null : JSON.stringify({ code, index, choice }));
}

/** The server says we already answered this question (e.g. after a reload): show it as locked in. */
function markAnswered(code, index) {
  const key = answerKey(code, index);
  if (answer?.key === key && answer.state !== 'sending') return;
  let choice = answer?.key === key ? answer.choice : null;
  if (choice == null) {
    try {
      const saved = JSON.parse(session.get(ANSWER_KEY) || 'null');
      if (saved?.code === code && saved.index === index) choice = saved.choice;
    } catch { /* ignore */ }
  }
  answer = { key, choice, state: 'locked' };
}

function renderQuestion() {
  const q = room.question;
  const key = answerKey(room.code, q.index);
  if (answer?.key !== key) answer = null;
  const playing = isPlayer();
  const bar = el('i');
  const timeLabel = el('span', { class: 'timer', 'aria-hidden': 'true' });
  const status = el('div', { class: 'banner info', role: 'status', hidden: true });
  const count = el('span', { class: 'muted' });
  const options = q.options.map((text, i) => el('button', { class: 'opt', 'aria-pressed': 'false', onclick: () => pick(i) }, text));
  const content = renderQuestionContent(q.text);
  questionUi = { key, playing, options, status, count, timeUp: false };
  clear(app).append(el('div', { class: 'card' },
    el('div', { class: 'qhead' },
      el('span', {}, `Question ${q.index + 1} of ${q.total ?? room.total}`),
      count,
      timeLabel),
    el('div', { class: 'bar', 'aria-hidden': 'true' }, bar),
    content,
    status,
    el('div', { class: 'opts', role: 'group', 'aria-label': 'Answers' }, options),
    playing ? el('p', { class: 'hint center' }, 'Tip: press 1-4 to answer') : null,
    isHost() ? el('div', { class: 'row', style: 'margin-top:16px;justify-content:flex-end' }, cancelGameButton()) : null));
  paintQuestion();
  if (document.hasFocus() && (!document.activeElement || document.activeElement === document.body || app.contains(document.activeElement))) {
    content.focus({ preventScroll: true });
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
  let text = '';
  let tone = 'info';
  if (!ui.playing) text = 'Presenter mode · Answers are hidden on this screen';
  else if (mine?.state === 'sending') text = 'Sending your answer…';
  else if (mine?.state === 'locked') text = 'Answer locked in. Waiting for the others…';
  else if (mine?.state === 'closed') { text = mine.note; tone = 'bad'; }
  else if (ui.timeUp) text = "Time's up! Waiting for the results…";
  ui.status.hidden = !text;
  ui.status.textContent = text;
  ui.status.className = `banner ${tone}`;
}

async function pick(choice) {
  const ui = questionUi;
  if (!ui || !ui.playing || ui.timeUp || answer?.key === ui.key) return;
  const { code } = room;
  const { index } = room.question;
  answer = { key: ui.key, choice, state: 'sending' };
  rememberAnswer(code, index, choice);
  paintQuestion();
  const r = await send('answer:submit', { code, index, choice });
  if (answer?.key !== ui.key || answer.state !== 'sending') return; // moved on, or a snapshot settled it
  if (r.ok) answer.state = 'locked';
  else if (isFinalAnswerError(r.error)) answer = { key: ui.key, choice: null, state: 'closed', note: r.error };
  else {
    // Retryable (busy server, lost connection): let the player try again.
    answer = null;
    rememberAnswer(code, index, null);
    toast(r.error || "Couldn't send your answer. Try again.");
  }
  paintQuestion();
}

function answerHotkey(e) {
  if (!questionUi || e.altKey || e.ctrlKey || e.metaKey || e.target?.closest?.('input, textarea, select')) return;
  const i = '1234'.indexOf(e.key);
  if (i >= 0 && i < questionUi.options.length && !questionUi.options[i].disabled) {
    e.preventDefault();
    pick(i);
  }
}

// ---------- reveal ----------
function renderReveal() {
  const r = room.result;
  const playing = isPlayer();
  const mine = r.myChoice || null;
  let banner;
  if (!playing) banner = el('div', { class: 'banner info', role: 'status' }, 'Results for this question');
  else if (!mine || mine.choice == null) banner = el('div', { class: 'banner bad', role: 'status' }, "Time's up. You didn't answer.");
  else if (mine.correct) banner = el('div', { class: 'banner good', role: 'status' }, `Correct! +${(mine.gained ?? 0).toLocaleString()} points`);
  else banner = el('div', { class: 'banner bad', role: 'status' }, 'Not quite.');

  const counts = r.optionCounts || [];
  const answered = r.answeredCount ?? counts.reduce((s, n) => s + (n || 0), 0);
  const opts = (r.options || []).map((text, i) => {
    const n = counts[i] || 0;
    const share = answered > 0 ? n / answered : 0;
    const label = `${n} ${n === 1 ? 'answer' : 'answers'}`;
    return el('button', {
      class: `opt reveal${i === r.correctIndex ? ' correct' : ' dim'}${mine?.choice === i ? ' picked' : ''}`,
      disabled: true,
      'aria-label': `${text}${i === r.correctIndex ? ' (correct)' : ''}${mine?.choice === i ? ' (your answer)' : ''}, ${label}`,
    },
    el('span', { class: 'opt-text' }, text),
    el('span', { class: 'opt-count', title: label }, n.toLocaleString()),
    el('i', { class: 'opt-share', style: `transform:scaleX(${share})`, 'aria-hidden': 'true' }));
  });

  const last = r.index + 1 >= (r.total ?? room.total);
  const nextLabel = el('span', { class: 'timer' });
  clear(app).append(el('div', { class: 'card' },
    el('div', { class: 'qhead' },
      el('span', {}, `Question ${r.index + 1} of ${r.total ?? room.total}`),
      el('span', {}, last ? 'Final results in ' : 'Next question in ', nextLabel)),
    renderQuestionContent(r.text || ''),
    banner,
    el('div', { class: 'opts' }, opts),
    el('p', { class: 'muted answered-line' }, `${answered.toLocaleString()} of ${(r.playerCount ?? room.playerCount ?? answered).toLocaleString()} answered`),
    el('h3', { style: 'margin-top:20px' }, 'Scoreboard'),
    boardTable(r.leaderboard || [], r.me, true),
    isHost() ? el('div', { class: 'row', style: 'margin-top:16px;justify-content:flex-end' }, cancelGameButton()) : null));
  if (typeof r.revealEndsAt === 'number') startCountdown(r.revealEndsAt, 0, null, nextLabel);
  else nextLabel.textContent = 'a moment';
}

/** Top 10, plus my own row under a gap when I'm further down. */
function boardTable(rows, meRow, showGain) {
  const { top, me: extra } = splitBoard(rows, meRow);
  const row = (p, cls = '') => el('tr', { class: `${cls}${p.userId === me.id ? ' me-row' : ''}`.trim() },
    rankCell(p.rank),
    el('td', {}, p.username, p.userId === me.id ? el('span', { class: 'pill', style: 'margin-left:6px' }, 'you') : null),
    el('td', { class: 'num' }, (p.score ?? 0).toLocaleString(),
      showGain && p.lastGain ? el('span', { class: 'gain' }, `+${p.lastGain.toLocaleString()}`) : null));
  if (!top.length) return el('p', { class: 'muted' }, 'No scores yet.');
  return el('div', { class: 'table-wrap' }, el('table', { class: 'board' },
    el('tbody', {},
      top.map((p) => row(p)),
      extra ? [el('tr', { class: 'gap', 'aria-hidden': 'true' }, el('td', { colspan: 3 }, '⋯')), row(extra)] : null)));
}

// ---------- end ----------
function renderEnd() {
  const f = room.final || {};
  const rows = f.leaderboard || [];
  const mine = f.me || rows.find((p) => p.userId === me.id) || null;
  const players = f.playerCount ?? room.playerCount;
  clear(app).append(el('div', { class: 'card' },
    el('h2', {}, 'Game over!'),
    mine
      ? el('p', { class: 'finish-line', role: 'status' },
          `You finished ${medal(mine.rank)}${players ? ` of ${players.toLocaleString()}` : ''} with ${(mine.score ?? 0).toLocaleString()} points (${mine.correctCount ?? 0} correct).`)
      : null,
    rows.length ? boardTable(rows, mine, false) : el('p', { class: 'muted' }, 'No players.'),
    el('div', { class: 'row', style: 'margin-top:16px' },
      el('button', { onclick: () => { room = null; homeTab = 'leaderboard'; route(); } }, 'See leaderboard'),
      el('button', { class: 'ghost', onclick: () => { room = null; homeTab = 'play'; route(); } }, 'Back to home'))));
}

boot();
