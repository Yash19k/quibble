// Shared helpers for the end-to-end tests (game.e2e.test.mjs) and the load test (load.mjs).
// No test framework in here: both a node:test suite and a plain script import it.
import crypto from 'node:crypto';

export const PROTOCOL = 3;

// Questions made by ensureLoadTestQuestions(): 5 s timers keep timer-closed questions short, and the text names the
// correct option ("... pick Charlie") so a test can answer right or wrong on purpose.
export const LOAD_CATEGORY = 'Load Test';
export const LOAD_TIME_LIMIT = 5;
export const LOAD_OPTIONS = ['Alpha', 'Bravo', 'Charlie', 'Delta'];

export const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
export const tag = (bytes = 3) => crypto.randomBytes(bytes).toString('hex');
export const randInt = (n) => Math.floor(Math.random() * n); // 0..n-1

/** Fisher-Yates on a copy. */
export function shuffle(items) {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Plain fetch that never throws on an HTTP status (tests assert on it): { status, body, headers }.
 * `body` is the parsed JSON, or { raw } when the response wasn't JSON (e.g. the dev server's index.html fallback).
 */
export async function http(base, path, { method = 'GET', body, token, headers = {} } = {}) {
  const res = await fetch(base.replace(/\/$/, '') + path, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text.slice(0, 200) };
  }
  return { status: res.status, body: parsed, headers: res.headers };
}

/** The n-th load-test question (n >= 1). Same text every run, so creating them is idempotent. */
export function loadQuestion(n) {
  const correctIndex = (n - 1) % LOAD_OPTIONS.length;
  return {
    text: `Load test ${String(n).padStart(2, '0')}: pick ${LOAD_OPTIONS[correctIndex]}`,
    options: [...LOAD_OPTIONS],
    correctIndex,
    category: LOAD_CATEGORY,
    timeLimit: LOAD_TIME_LIMIT,
  };
}

/** Index of the option a load-test question asks for, or -1 for any other question. */
export function correctOptionOf(question) {
  const m = /: pick (\w+)$/.exec(question?.text || '');
  return m && Array.isArray(question.options) ? question.options.indexOf(m[1]) : -1;
}

/**
 * Make sure the "Load Test" category has at least `count` questions and that all of them use a 5 s timer
 * (idempotent: existing questions are reused, wrong timers are fixed). `call(path, {method, body, token})` must
 * return the parsed JSON body and throw on an HTTP error. Returns { existing, created, fixed }.
 */
export async function ensureLoadTestQuestions(call, adminToken, count) {
  const query = `/api/admin/questions?category=${encodeURIComponent(LOAD_CATEGORY)}`;
  const { questions = [] } = await call(query, { token: adminToken });
  const mine = questions.filter((q) => q.category === LOAD_CATEGORY);
  let fixed = 0;
  for (const q of mine) {
    if (q.timeLimit === LOAD_TIME_LIMIT) continue;
    const body = { text: q.text, options: q.options, correctIndex: q.correctIndex, category: LOAD_CATEGORY, timeLimit: LOAD_TIME_LIMIT };
    await call(`/api/admin/questions/${encodeURIComponent(q.id)}`, { method: 'PUT', token: adminToken, body });
    fixed += 1;
  }
  const texts = new Set(mine.map((q) => q.text));
  let created = 0;
  for (let n = 1; mine.length + created < count; n++) {
    const q = loadQuestion(n);
    if (texts.has(q.text)) continue;
    await call('/api/admin/questions', { method: 'POST', token: adminToken, body: q });
    created += 1;
  }
  return { existing: mine.length, created, fixed };
}

// ---------- numbers ----------
/** Nearest-rank percentile of an ascending array (p in 0..1). */
export function percentile(sorted, p) {
  if (!sorted.length) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

/** { n, p50, p95, max, mean } of a list of numbers (NaN fields when empty). */
export function summarize(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const mean = sorted.length ? sorted.reduce((s, v) => s + v, 0) / sorted.length : NaN;
  return { n: sorted.length, p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), max: sorted.at(-1) ?? NaN, mean };
}

/**
 * Problems with a leaderboard: sorted by score (best first) with competition ranks (ties share a rank; the next
 * distinct score's rank counts every player above it). `rows` must be the top of the full ranking.
 */
export function rankProblems(rows) {
  const problems = [];
  rows.forEach((r, i) => {
    if (i === 0) {
      if (r.rank !== 1) problems.push(`first row has rank ${r.rank}`);
      return;
    }
    const prev = rows[i - 1];
    if (r.score > prev.score) problems.push(`row ${i + 1} (${r.score}) outscores row ${i} (${prev.score})`);
    const want = r.score === prev.score ? prev.rank : i + 1;
    if (r.rank !== want) problems.push(`row ${i + 1} has rank ${r.rank}, expected ${want}`);
  });
  return problems;
}
