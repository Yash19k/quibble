// Unit tests for the pure helpers behind the REST API: leaderboard boards, rate-limit windows, the question cache.
// No AWS or dev server needed:  node --test aws/tests/auth.unit.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregate, buildBoard, BOARD_ID } from '../backend/src/lib/results.js';
import { fixedWindow, loginFailureKeys } from '../backend/src/lib/ratelimit.js';
import { asyncCache, sample } from '../backend/src/lib/questions.js';

// ---------- boards ----------
const row = (userId, score, rank, endedAt = '2026-11-18T10:00:00.000Z', correctCount = 1) =>
  ({ userId, username: `old_${userId}`, score, rank, correctCount, endedAt, sk: `${endedAt}#ABCDEF` });

const users = new Map([
  ['a', { id: 'a', username: 'alice' }],
  ['b', { id: 'b', username: 'bob' }],
  ['c', { id: 'c', username: 'carol' }],
  ['x', { id: 'x', username: 'mallory', banned: true }],
]);

test('aggregate sums points, games, wins and correct answers per player', () => {
  const totals = aggregate([row('a', 900, 1, undefined, 3), row('a', 100, 2, undefined, 1), row('b', 50, 3)]);
  assert.deepEqual(totals.find((t) => t.userId === 'a'),
    { userId: 'a', username: 'old_a', totalScore: 1000, gamesPlayed: 2, wins: 1, correctAnswers: 4 });
  assert.equal(totals.length, 2);
});

test('buildBoard ranks by points, then wins, then name, with current usernames', () => {
  const board = buildBoard([row('a', 500, 2), row('b', 500, 1), row('c', 500, 2), row('c', 0, 3)], users);
  assert.deepEqual(board.map((r) => [r.rank, r.username]), [[1, 'bob'], [2, 'alice'], [3, 'carol']]);
  assert.deepEqual(board[0], { rank: 1, username: 'bob', totalScore: 500, gamesPlayed: 1, wins: 1, correctAnswers: 1 });
  assert.ok(board.every((r) => !('userId' in r)), 'rows keep the public shape (no userId)');
});

test('buildBoard drops banned and deleted accounts and stored board items', () => {
  const board = buildBoard(
    [row('x', 9999, 1), row('gone', 5000, 1), row('a', 10, 1), { userId: BOARD_ID, sk: 'all', rows: [] }],
    users
  );
  assert.deepEqual(board.map((r) => r.username), ['alice']);
});

test('buildBoard counts rows with missing numbers as zero', () => {
  const board = buildBoard([{ userId: 'a', endedAt: '2026-11-18T10:00:00.000Z', rank: 2 }], users);
  assert.deepEqual(board, [{ rank: 1, username: 'alice', totalScore: 0, gamesPlayed: 1, wins: 0, correctAnswers: 0 }]);
});

test('buildBoard week view only counts games since the cut-off; limit caps the rows', () => {
  const rows = [row('a', 700, 1, '2026-11-01T00:00:00.000Z'), row('b', 300, 1, '2026-11-18T00:00:00.000Z'), row('a', 100, 2, '2026-11-18T00:00:00.000Z')];
  const week = buildBoard(rows, users, { sinceIso: '2026-11-12T00:00:00.000Z' });
  assert.deepEqual(week.map((r) => [r.username, r.totalScore]), [['bob', 300], ['alice', 100]]);
  assert.equal(buildBoard(rows, users, { limit: 1 }).length, 1);
  assert.deepEqual(buildBoard([], users), []);
});

// ---------- rate limits ----------
test('fixedWindow gives the window index, its end and the seconds left', () => {
  const w = fixedWindow(15 * 60 * 1000 * 4 + 1500, 15 * 60 * 1000);
  assert.equal(w.index, 4);
  assert.equal(w.endsAt, 15 * 60 * 1000 * 5);
  assert.equal(w.retryAfter, 15 * 60 - 1); // 898.5 s left -> 899
  assert.equal(fixedWindow(999, 1000).retryAfter, 1, 'never 0');
});

test('login failure keys: per IP and per account, case-insensitive, email not stored in clear', () => {
  const now = Date.UTC(2026, 10, 19, 12, 0, 0);
  const a = loginFailureKeys('203.0.113.7', 'Alice@Example.com ', now);
  const b = loginFailureKeys('198.51.100.1', 'alice@example.com', now);
  assert.equal(a.email, b.email, 'same account from two IPs shares one counter');
  assert.notEqual(a.ip, b.ip);
  assert.match(a.ip, /203\.0\.113\.7/);
  assert.doesNotMatch(a.email, /alice|example/i);
  assert.notEqual(loginFailureKeys('203.0.113.7', 'alice@example.com', now + 15 * 60 * 1000).email, a.email, 'a new window starts a new counter');
});

// ---------- question cache ----------
function fakeLoader() {
  const calls = [];
  const load = () => new Promise((resolve, reject) => calls.push({ resolve, reject }));
  return { load, calls };
}

test('asyncCache shares one in-flight load between concurrent callers', async () => {
  const { load, calls } = fakeLoader();
  const cache = asyncCache(load, 30_000);
  const p1 = cache.get();
  const p2 = cache.get();
  await Promise.resolve(); // the load starts on the next microtask
  assert.equal(calls.length, 1);
  calls[0].resolve(['q1']);
  assert.deepEqual(await p1, ['q1']);
  assert.equal(await p2, await p1);
});

test('asyncCache reuses a value until it expires, and reloads after invalidate or fresh', async () => {
  let now = 0;
  let n = 0;
  const cache = asyncCache(async () => ++n, 30_000, () => now);
  assert.equal(await cache.get(), 1);
  now = 29_999;
  assert.equal(await cache.get(), 1);
  now = 30_000;
  assert.equal(await cache.get(), 2, 'expired');
  cache.invalidate();
  assert.equal(await cache.get(), 3, 'invalidated');
  assert.equal(await cache.get({ fresh: true }), 4, 'fresh bypasses the cache');
  assert.equal(await cache.get(), 4, '...and refills it');
});

test('asyncCache never caches a failure', async () => {
  let fail = true;
  const cache = asyncCache(async () => {
    if (fail) throw new Error('throttled');
    return 'ok';
  }, 30_000);
  await assert.rejects(cache.get(), /throttled/);
  fail = false;
  assert.equal(await cache.get(), 'ok');
});

test('asyncCache: a load that started before invalidate does not replace the newer one', async () => {
  const { load, calls } = fakeLoader();
  const cache = asyncCache(load, 30_000);
  const old = cache.get();
  await Promise.resolve();
  cache.invalidate();
  const newer = cache.get();
  await Promise.resolve();
  calls[0].reject(new Error('old load failed'));
  await assert.rejects(old);
  calls[1].resolve('new');
  assert.equal(await newer, 'new');
  assert.equal(await cache.get(), 'new', 'the failed old load did not clear the new entry');
  assert.equal(calls.length, 2);
});

// ---------- sampling ----------
test('sample returns distinct items without touching the input', () => {
  const items = Array.from({ length: 50 }, (_, i) => i);
  const picked = sample(items, 10);
  assert.equal(picked.length, 10);
  assert.equal(new Set(picked).size, 10);
  assert.ok(picked.every((x) => items.includes(x)));
  assert.deepEqual(items, Array.from({ length: 50 }, (_, i) => i));
  assert.equal(sample(items, 99).length, 50, 'never more than there are');
  assert.deepEqual(sample(items, 0), []);
  assert.deepEqual(sample([], 5), []);
});

test('sample is not biased towards the front of the list', () => {
  const hits = new Array(10).fill(0);
  for (let i = 0; i < 4000; i++) for (const x of sample([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 3)) hits[x]++;
  // Each item is expected 1200 times; allow a generous margin so the test never flakes.
  assert.ok(hits.every((h) => h > 900 && h < 1500), JSON.stringify(hits));
});
