// Tiny helpers shared by the player app and the admin panel.

// config.js (generated at deploy time) says where the API Gateway endpoints live.
const CONFIG = window.QUIBBLE_CONFIG || {};
export const API_URL = (CONFIG.apiUrl || '').replace(/\/$/, '');
export const WS_URL = CONFIG.wsUrl || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;

// The login token lives in localStorage and is sent as a Bearer header (the site and the APIs
// are on different origins, so a cookie won't do). All rendering uses textContent, so XSS
// can't read it out.
const TOKEN_KEY = 'quibble.token';
export function getToken() {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}
export function setToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* private mode: stays logged in for this page only */ }
}

export async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(API_URL + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    const err = new Error(data?.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// el('div', {class:'x', onclick: fn}, 'text', childEl) — builds DOM with textContent only,
// so user-provided text (usernames, question text) can never inject HTML.
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'class') node.className = v;
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

let toastTimer;
export function toast(msg) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}

// 1 -> "1st", 2 -> "2nd", 11 -> "11th", 23 -> "23rd"
export const medal = (rank) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = rank % 100;
  return rank + (s[(v - 20) % 10] || s[v] || s[0]);
};

// Rank cell for tables; CSS gives the top three gold / silver / bronze badges.
export const rankCell = (rank) => el('td', { class: `medal r${rank}` }, el('span', { class: 'rk' }, rank));
