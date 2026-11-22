// Helpers shared by the player app and the admin panel.
// Nothing here touches the DOM at module load, so the pure helpers at the bottom can be unit-tested in Node.
import { request } from './net.js';

// config.js (generated at deploy time) says where the API Gateway endpoints live.
const CONFIG = globalThis.QUIBBLE_CONFIG || {};
export const API_URL = (CONFIG.apiUrl || '').replace(/\/$/, '');
export const WS_URL = CONFIG.wsUrl
  || (typeof location !== 'undefined' ? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws` : '');

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- storage ----------
// Storage can be missing or throw (private mode, blocked cookies). Memory keeps the session working for this page.
const memory = new Map();
function readKey(key, area = 'localStorage') {
  try {
    const value = globalThis[area]?.getItem(key);
    if (value != null) return value;
  } catch { /* unavailable */ }
  return memory.has(`${area}:${key}`) ? memory.get(`${area}:${key}`) : null;
}
/** Returns true when the value reached real storage (not just memory). */
function writeKey(key, value, area = 'localStorage') {
  if (value == null) memory.delete(`${area}:${key}`);
  else memory.set(`${area}:${key}`, value);
  try {
    const store = globalThis[area];
    if (!store) return false;
    if (value == null) store.removeItem(key);
    else store.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}
export const session = {
  get: (key) => readKey(key, 'sessionStorage'),
  set: (key, value) => writeKey(key, value, 'sessionStorage'),
};

// The login token is sent as a Bearer header (the site and the APIs are on different origins, so a cookie won't
// do). All rendering uses textContent, so injected HTML can't read it out.
const TOKEN_KEY = 'quibble.token';
const PROFILE_KEY = 'quibble.profile'; // last known public profile: the page renders at once, without /api/auth/me
const EMAIL_KEY = 'quibble.email'; // pre-fills the login form

export const getToken = () => readKey(TOKEN_KEY);
export function setToken(token) {
  writeKey(TOKEN_KEY, token || null);
}
export function getProfile() {
  try { return JSON.parse(readKey(PROFILE_KEY) || 'null'); } catch { return null; }
}
export function setProfile(user) {
  writeKey(PROFILE_KEY, user ? JSON.stringify({ id: user.id, email: user.email, username: user.username, role: user.role }) : null);
}
export const getLastEmail = () => readKey(EMAIL_KEY) || '';
export const setLastEmail = (email) => writeKey(EMAIL_KEY, email || null);

// ---------- REST ----------
const BUSY_TEXT = 'Server busy, still trying…';
let apiRetrying = 0;

/** Calls the REST API with retries (see net.js). Throws an Error with .status, .body and .field. */
export async function api(path, { method = 'GET', body, budgetMs } = {}) {
  let retried = false;
  try {
    return await request(API_URL, path, {
      method,
      body,
      budgetMs,
      token: getToken(),
      onRetry: () => {
        if (retried) return;
        retried = true;
        apiRetrying += 1;
        setNotice('busy-api', BUSY_TEXT);
      },
    });
  } finally {
    if (retried && --apiRetrying === 0) setNotice('busy-api', null);
  }
}

// ---------- DOM ----------
// el('div', {class:'x', onclick: fn}, 'text', childEl) - builds DOM with textContent only,
// so user-provided text (usernames, question text) can never inject HTML.
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k.startsWith('on')) {
      if (typeof v === 'function') node.addEventListener(k.slice(2), v);
      continue; // never an inline handler from a string (the CSP would block it anyway)
    }
    // URL attributes never take a script URL, whatever a future caller passes in.
    // (Browsers ignore tabs, newlines and leading control characters in a URL's scheme, so those are removed first.)
    if (['href', 'src', 'action', 'formaction'].includes(k)
      && /^(javascript:|vbscript:|data:text\/html)/i.test(String(v).replace(/[\u0000- ]/g, ''))) continue;
    if (k === 'class') node.className = v;
    else if (k === 'value') node.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected') node[k] = !!v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function clear(node) { node.replaceChildren(); return node; }

let dialogSeq = 0;
/**
 * A themed confirmation popup instead of the browser's confirm(). Resolves true when confirmed; Escape, the Cancel
 * button or a click outside resolve false. `danger` paints the confirm button red and focuses Cancel first.
 */
export function confirmDialog({ title, message = '', confirmLabel = 'OK', cancelLabel = 'Cancel', danger = false } = {}) {
  return new Promise((resolve) => {
    const id = `dlg${++dialogSeq}`;
    const cancel = el('button', { type: 'button', class: 'ghost', onclick: () => dlg.close('cancel') }, cancelLabel);
    const ok = el('button', { type: 'button', class: danger ? 'danger' : '', onclick: () => dlg.close('ok') }, confirmLabel);
    const dlg = el('dialog', { class: 'modal', 'aria-labelledby': `${id}-t`, 'aria-describedby': message ? `${id}-m` : null },
      el('h3', { id: `${id}-t` }, title),
      message ? el('p', { id: `${id}-m`, class: 'muted' }, message) : null,
      el('div', { class: 'modal-actions' }, cancel, ok));
    // A click on the backdrop lands on the <dialog> itself (its content is inside a padded box).
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close('cancel'); });
    dlg.addEventListener('close', () => {
      resolve(dlg.returnValue === 'ok');
      dlg.remove();
    }, { once: true });
    document.body.append(dlg);
    dlg.showModal();
    (danger ? cancel : ok).focus();
  });
}

let toastTimer;
export function toast(msg) {
  const t = document.getElementById('toast');
  if (!t || !msg) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

// One status bar for connection trouble. Several sources can be active; the most important one is shown.
const NOTICE_RANK = { offline: 0, reconnecting: 1, 'busy-ws': 2, 'busy-api': 3 };
const notices = new Map();
export function setNotice(key, text) {
  if (text) notices.set(key, text);
  else notices.delete(key);
  if (typeof document === 'undefined') return;
  let bar = document.getElementById('netbar');
  if (!bar) {
    bar = el('div', { id: 'netbar', class: 'netbar', role: 'status', 'aria-live': 'polite', hidden: true });
    const header = document.querySelector('header.top');
    if (header) header.after(bar);
    else document.body.prepend(bar);
  }
  const top = [...notices.keys()].sort((a, b) => (NOTICE_RANK[a] ?? 9) - (NOTICE_RANK[b] ?? 9))[0];
  bar.hidden = !top;
  bar.textContent = top ? notices.get(top) : '';
  if (top) bar.dataset.kind = top;
}

/**
 * Runs `fn` with the button disabled and showing `label` (e.g. "Joining…"), so a slow server can't be
 * double-submitted. Returns fn's result, or undefined when the button was already busy.
 */
export async function withPending(button, label, fn) {
  if (!button || button.getAttribute('aria-busy') === 'true') return undefined;
  const kids = [...button.childNodes];
  const wasDisabled = button.disabled;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.classList.add('pending');
  if (label) button.replaceChildren(label);
  try {
    return await fn();
  } finally {
    button.disabled = wasDisabled;
    button.removeAttribute('aria-busy');
    button.classList.remove('pending');
    if (label) button.replaceChildren(...kids);
  }
}

/** Copies text. The Clipboard API needs HTTPS; plain-HTTP pages fall back to selecting `input` + execCommand. */
export async function copyText(text, input) {
  try {
    if (globalThis.isSecureContext && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall back */ }
  try {
    input?.focus();
    input?.select();
    input?.setSelectionRange?.(0, text.length);
    return document.execCommand('copy');
  } catch {
    return false;
  }
}

// 1 -> "1st", 2 -> "2nd", 11 -> "11th", 23 -> "23rd"
export const medal = (rank) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = rank % 100;
  return rank + (s[(v - 20) % 10] || s[v] || s[0]);
};

// Rank cell for tables; CSS gives the top three gold / silver / bronze badges.
export const rankCell = (rank) => el('td', { class: `medal r${rank}` }, el('span', { class: 'rk' }, rank));

// ---------- pure helpers (no DOM; unit-tested in Node) ----------

/** Random hex id. Uses crypto.getRandomValues: randomUUID/subtle don't exist on plain-HTTP pages. */
export function randomId(bytes = 16) {
  const a = new Uint8Array(bytes);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(a);
  else for (let i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256); // very old browsers only
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The JWT payload ({sub, iat, exp}) without verifying it (the server does that), or null. */
export function decodeJwt(token) {
  try {
    const part = String(token).split('.')[1];
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '=')));
  } catch {
    return null;
  }
}

/** Is the token unreadable or (about to be) expired? A minute of slack for clock skew. */
export function tokenExpired(token, now = Date.now()) {
  const payload = decodeJwt(token);
  if (!payload?.sub) return true;
  return typeof payload.exp === 'number' && payload.exp * 1000 <= now + 60_000;
}

/** "?code=abc123" -> "ABC123" (null unless it looks like a game code). */
export function parseJoinCode(search) {
  const raw = new URLSearchParams(search || '').get('code') || '';
  const code = raw.trim().toUpperCase();
  return /^[A-Z0-9]{6}$/.test(code) ? code : null;
}

/** The shareable link for a game, next to the current page (works under any path or bucket host). */
export function joinUrl(code, pageHref) {
  const url = new URL('play.html', pageHref);
  url.search = `?code=${encodeURIComponent(code)}`;
  url.hash = '';
  return url.href;
}

/** Top rows of a board plus my own row when it isn't among them. */
export function splitBoard(rows, me, size = 10) {
  const top = (rows || []).slice(0, size);
  const inTop = !!me && top.some((r) => r.userId === me.userId);
  return { top, me: me && !inTop ? me : null };
}

/**
 * What the lobby shows. The host gets every member; players get the most recent joiners only, so the
 * rest is summed up as "and N more". A presenter host (not playing) isn't listed as a player.
 */
export function lobbyView(room, meId) {
  const presenter = (p) => p.userId === room.hostId && !room.hostPlays;
  const chips = (room.players || []).filter((p) => !presenter(p)).map((p) => ({
    userId: p.userId,
    username: p.username,
    connected: p.connected !== false,
    host: p.userId === room.hostId,
    me: p.userId === meId,
  }));
  const playerCount = Math.max(Number(room.playerCount) || 0, chips.length);
  return { chips, playerCount, more: playerCount - chips.length };
}

/** Is this server update older than what we already show for the same game? (`v` = the game's version) */
export function isStale(room, data) {
  return !!room && !!data && room.code === data.code
    && typeof room.v === 'number' && typeof data.v === 'number' && data.v < room.v;
}

/** Answer errors that can't be fixed by trying again; anything else re-enables the options. */
const FINAL_ANSWER_ERRORS = new Set(['Too late!', 'No question is open right now.']);
export const isFinalAnswerError = (error) => FINAL_ANSWER_ERRORS.has(error);
