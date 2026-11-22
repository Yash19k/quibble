// Presence heartbeat for the admin Analytics page ("who is online", visits, time on site). Runs on every page.
//
// While the tab is visible it POSTs /api/presence every 30 s with an anonymous browser id, a session id (a new one
// after 30 idle minutes or 12 hours), the page and, in a game, its code. Hiding or closing the tab sends a last
// "leave" beat so the visitor drops off the online list at once. The login token, when there is one, names the account;
// nothing else about the visitor is sent.
//
// Pages that change state without navigating (play.html: lobby -> game) call setPresence({ page, game }).
const BEAT_MS = 30_000;
const IDLE_MS = 30 * 60_000;
const MAX_SESSION_MS = 12 * 60 * 60_000;
const VID_KEY = 'quibble.vid';
const SID_KEY = 'quibble.sid'; // "<sid> <last active ms>"
const TOKEN_KEY = 'quibble.token';

const CONFIG = globalThis.QUIBBLE_CONFIG || {};
const API = (CONFIG.apiUrl || '').replace(/\/$/, '');

const read = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode: this page only */ } };

function hex(bytes) {
  const a = new Uint8Array(bytes);
  if (globalThis.crypto?.getRandomValues) crypto.getRandomValues(a);
  else for (let i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

let memVid = null;
function visitorId() {
  let v = read(VID_KEY) || memVid;
  if (!v || !/^[0-9a-f]{24}$/.test(v)) {
    v = hex(12);
    write(VID_KEY, v);
  }
  memVid = v;
  return v;
}

let memSid = null;
/** The current session id, or a new one after 30 idle minutes / 12 hours. Shared by the tabs of one browser. */
function sessionId(now) {
  const [sid, lastStr] = (read(SID_KEY) || memSid || '').split(' ');
  const last = Number(lastStr);
  const born = sid ? parseInt(sid.slice(0, 8), 36) : 0;
  const fresh = sid && /^[0-9a-z]{8}[0-9a-f]{16}$/.test(sid) && now - last < IDLE_MS && now - born < MAX_SESSION_MS;
  const id = fresh ? sid : `${now.toString(36).padStart(8, '0')}${hex(8)}`;
  memSid = `${id} ${now}`;
  write(SID_KEY, memSid);
  return { id, isNew: !fresh };
}

const state = { page: document.body?.dataset.page || 'home', game: null };
let visibleSince = document.visibilityState === 'visible' ? Date.now() : null;
let timer = null;
let sentRef = false;

function send({ leave = false } = {}) {
  if (!navigator.onLine && !leave) return;
  const now = Date.now();
  const dt = visibleSince ? Math.round((now - visibleSince) / 1000) : 0;
  visibleSince = leave ? null : now;
  const { id: sid, isNew } = sessionId(now);
  const body = { sid, vid: visitorId(), page: state.page, game: state.game, dt, leave };
  if ((isNew || !sentRef) && document.referrer) {
    try {
      if (new URL(document.referrer).host !== location.host) body.ref = document.referrer;
    } catch { /* ignore */ }
  }
  sentRef = true;
  const headers = { 'content-type': 'application/json' };
  const token = read(TOKEN_KEY);
  if (token) headers.authorization = `Bearer ${token}`;
  // keepalive lets the "leave" beat finish while the page unloads.
  fetch(`${API}/api/presence`, { method: 'POST', headers, body: JSON.stringify(body), keepalive: true, credentials: 'omit' })
    .catch(() => { /* analytics never bothers the visitor */ });
}

function start() {
  clearInterval(timer);
  visibleSince = Date.now();
  send();
  timer = setInterval(() => send(), BEAT_MS);
}

function stop() {
  clearInterval(timer);
  timer = null;
  send({ leave: true });
}

/** The page changed without a navigation (play.html joining or leaving a game). */
export function setPresence({ page, game = null }) {
  if (page === state.page && game === state.game) return;
  state.page = page;
  state.game = game;
  if (document.visibilityState === 'visible') start();
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') start();
  else if (timer) stop();
});
addEventListener('pagehide', () => { if (timer) stop(); });
addEventListener('pageshow', (e) => { if (e.persisted && document.visibilityState === 'visible') start(); });
if (document.visibilityState === 'visible') start();
