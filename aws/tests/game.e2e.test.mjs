// End-to-end tests (protocol 3) against a running Quibble backend: the local emulator (npm run dev) or a deployment:
//   QA_API=https://xxx.execute-api... QA_WS=wss://xxx... ADMIN_PASSWORD=... npm run test:e2e
// Optional:
//   QA_MAX_PLAYERS=n   the server's MAX_PLAYERS when it was lowered (asserted exactly; MAX_PLAYERS in this shell works
//                      too). Without it the limit is found by joining until the game is full (up to 250 + 1 players)
//                      and must be at most 250.
//   QA_SKIP_FULL=1     skip that test (it signs up ~250 accounts).
// The "Load Test" category (5-second questions whose text names the right option) is created through the admin API
// (ADMIN_EMAIL / ADMIN_PASSWORD) so timer-closed questions are quick and answers can be right or wrong on purpose.
// Raw `ws` sockets on purpose: these tests control every frame (duplicates, resends, a socket dropped before its ack).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { request } from '../../public/js/net.js';
import { PROTOCOL, LOAD_CATEGORY, ensureLoadTestQuestions, correctOptionOf, http, rankProblems, sleep, tag } from './helpers.mjs';

const API = (process.env.QA_API || 'http://localhost:5050').replace(/\/$/, '');
const WS_URL = process.env.QA_WS || 'ws://localhost:5050/ws';
const ADMIN = { email: process.env.ADMIN_EMAIL || 'admin@example.com', password: process.env.ADMIN_PASSWORD || 'admin12345' };
const MAX_PLAYERS = Number(process.env.QA_MAX_PLAYERS || process.env.MAX_PLAYERS) || null; // as the server was started with
const SPEC_MAX_PLAYERS = 250;
const PASSWORD = 'password123';
const CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/; // no 0/O/1/I
const PHASE_EVENTS = new Set(['question:show', 'question:result', 'game:end', 'game:cancelled']);

// ---------- REST ----------
/** One attempt, never throws: { status, body }. For asserting on status codes. */
const api = (path, opts) => http(API, path, opts);
/** Like the page (public/js/net.js): retries busy / throttled answers, returns the body, throws on failure. */
const call = (path, opts = {}) => request(API, path, opts);

/** A new account (username `<prefix>_<8 hex>`, so prefix <= 11 chars). Returns { id, email, username, role, token }. */
async function register(prefix) {
  const username = `${prefix}_${tag(4)}`;
  const body = { email: `${username.toLowerCase()}@e2e.test`, username, password: PASSWORD };
  let data;
  try {
    data = await call('/api/auth/register', { method: 'POST', body });
  } catch (err) {
    // Like the sign-up page: a 409 on the email after a retry means an earlier attempt that timed out did work.
    if (err?.status !== 409 || err.field !== 'email') throw err;
    data = await call('/api/auth/login', { method: 'POST', body: { email: body.email, password: PASSWORD } });
  }
  return { ...data.user, token: data.token };
}

async function registerMany(n, prefix) {
  const users = [];
  for (let i = 0; i < n; i += 50) {
    users.push(...(await Promise.all(Array.from({ length: Math.min(50, n - i) }, () => register(prefix)))));
  }
  return users;
}

let adminTokenPromise;
const adminToken = () => (adminTokenPromise ??= call('/api/auth/login', { method: 'POST', body: ADMIN }).then((d) => {
  assert.equal(d.user.role, 'admin', `${ADMIN.email} is not an admin (set ADMIN_EMAIL / ADMIN_PASSWORD)`);
  return d.token;
}));

/** The "Load Test" category with 5 s questions exists (made through the admin API on first use). */
let loadReadyPromise;
const loadReady = () => (loadReadyPromise ??= adminToken().then((token) => ensureLoadTestQuestions(call, token, 5)));

/** The local dev server's emulator counters, or null (e.g. a deployment). */
async function localStats() {
  try {
    const r = await api('/__local/stats');
    return r.status === 200 && r.body?.invocations ? r.body : null;
  } catch {
    return null;
  }
}

// ---------- a raw WebSocket client ----------
const sockets = new Set(); // every socket ever opened, so nothing keeps the test process alive

class Client {
  constructor(user, label = user.username) {
    this.user = user;
    this.label = label;
    this.ws = null;
    this.seq = 0;
    this.pending = new Map(); // id -> { frame, event, timer, settle, fail }
    this.events = []; // { event, data, at, taken }
    this.waiters = new Set();
    this.errorFrames = [];
    this.closed = null; // resolves { code, reason } when the socket closes
  }

  /** Opens a socket for `user`; rejects with "socket rejected: HTTP <status>" when $connect refuses it. */
  static async connect(user, label) {
    const c = new Client(user, label);
    await c.open();
    return c;
  }

  open() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${WS_URL}?token=${encodeURIComponent(this.user.token || '')}`);
      this.ws = ws;
      sockets.add(ws);
      let settled = false;
      const done = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve(this);
      };
      const timer = setTimeout(() => {
        done(new Error(`${this.label}: the socket did not open within 15 s`));
        ws.terminate();
      }, 15_000);
      ws.on('error', (err) => done(err)); // also absorbs errors after the open
      ws.on('unexpected-response', (_req, res) => {
        done(new Error(`${this.label}: socket rejected: HTTP ${res.statusCode}`));
        ws.terminate();
      });
      ws.on('open', () => done());
      ws.on('message', (raw) => {
        if (ws === this.ws) this.onFrame(raw);
      });
      this.closed = new Promise((r) => ws.on('close', (code, reason) => {
        sockets.delete(ws);
        r({ code, reason: String(reason) });
      }));
    });
  }

  onFrame(raw) {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg?.type === 'ack') {
      const entry = this.pending.get(msg.id);
      if (!entry) return; // the ack of a resent duplicate
      this.pending.delete(msg.id);
      entry.settle(msg);
    } else if (msg?.type === 'event') {
      this.events.push({ event: msg.event, data: msg.data, at: Date.now(), taken: false });
      this.wake();
    } else if (msg && 'message' in msg) {
      // API Gateway's own error frame (throttled or crashed handler). It doesn't say which message failed: like the page,
      // send everything still waiting again (every action is idempotent). /__local/stats catches crashes at the end.
      this.errorFrames.push(msg);
      setTimeout(() => {
        for (const entry of this.pending.values()) this.transmit(entry);
      }, 200 + Math.random() * 600);
    }
  }

  /**
   * Sends one message and resolves with its ack ({ ok, error?, ...fields }). Like realtime.js it is resent with the same
   * id when no ack comes back (3 s, then backing off) or after an error frame; it fails after `timeoutMs`.
   */
  send(event, data = {}, { id = ++this.seq, timeoutMs = 30_000 } = {}) {
    return new Promise((resolve, reject) => {
      const entry = { frame: JSON.stringify({ action: 'message', id, event, data }), event, sends: 0, timer: null };
      const giveUp = setTimeout(() => {
        this.pending.delete(id);
        clearTimeout(entry.timer);
        reject(new Error(`${this.label}: no ack for ${event} within ${timeoutMs} ms`));
      }, timeoutMs);
      entry.settle = (ack) => {
        clearTimeout(giveUp);
        clearTimeout(entry.timer);
        resolve(ack);
      };
      entry.fail = (err) => {
        clearTimeout(giveUp);
        clearTimeout(entry.timer);
        reject(err);
      };
      this.pending.set(id, entry);
      this.transmit(entry);
    });
  }

  transmit(entry) {
    clearTimeout(entry.timer);
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(entry.frame);
    entry.sends += 1;
    entry.timer = setTimeout(() => this.transmit(entry), Math.min(8000, 3000 * entry.sends));
  }

  /**
   * Puts one message on the wire and closes the socket straight away; nothing that comes back on it (the ack) is
   * seen. The frame is written before the close frame, so the server still receives it.
   */
  sendAndDrop(id, event, data) {
    const ws = this.ws;
    ws.send(JSON.stringify({ action: 'message', id, event, data }));
    this.drop();
  }

  /** hello / sync with the current protocol; asserts the ack is a usable one. */
  async hello(event = 'hello') {
    const ack = await this.send(event, { protocol: PROTOCOL });
    assert.equal(ack.ok, true, `${this.label}: ${event} failed: ${ack.error}`);
    assert.ok(!ack.reload, `${this.label}: ${event} asked for a reload`);
    assert.equal(ack.user?.id, this.user.id, `${event} acks carry the user's profile`);
    assert.equal(typeof ack.inGame, 'boolean');
    if (ack.inGame) assert.ok(ack.snapshot?.code, `${event}: inGame comes with a snapshot`);
    return ack;
  }

  /** The first not-yet-taken `event` whose data matches `where`: already received, or arriving within `timeoutMs`. */
  next(event, where = () => true, timeoutMs = 20_000) {
    const found = this.events.find((e) => !e.taken && e.event === event && where(e.data));
    if (found) {
      found.taken = true;
      return Promise.resolve(found.data);
    }
    return new Promise((resolve, reject) => {
      const w = { event, where, resolve, timer: null };
      w.timer = setTimeout(() => {
        this.waiters.delete(w);
        const got = this.events.filter((e) => e.event === event).map((e) => JSON.stringify(e.data).slice(0, 160));
        reject(new Error(`${this.label}: no matching ${event} within ${timeoutMs} ms (got ${got.length}: ${got.slice(-3).join(' | ') || '-'})`));
      }, timeoutMs);
      this.waiters.add(w);
    });
  }

  wake() {
    for (const w of [...this.waiters]) {
      const e = this.events.find((x) => !x.taken && x.event === w.event && w.where(x.data));
      if (!e) continue;
      e.taken = true;
      clearTimeout(w.timer);
      this.waiters.delete(w);
      w.resolve(e.data);
    }
  }

  /** Forget the `event`s received so far, so next() only sees newer ones (e.g. the lobby list after a change). */
  flush(event) {
    for (const e of this.events) if (e.event === event) e.taken = true;
  }

  /** Every `event` received so far (taken or not), oldest first. */
  all(event, where = () => true) {
    return this.events.filter((e) => e.event === event && where(e.data)).map((e) => e.data);
  }

  /** Stop listening and close the socket. Messages still waiting for an ack fail. */
  drop() {
    const ws = this.ws;
    this.ws = null;
    for (const [id, entry] of this.pending) {
      this.pending.delete(id);
      entry.fail(new Error(`${this.label}: socket closed before the ack of ${entry.event}`));
    }
    if (ws && ws.readyState !== WebSocket.CLOSED) ws.close();
  }

  close() {
    this.drop();
    for (const w of this.waiters) clearTimeout(w.timer);
    this.waiters.clear();
  }
}

/** A socket that is closed when the test ends. */
async function connect(t, user, label) {
  const c = await Client.connect(user, label);
  t.after(() => c.close());
  return c;
}

after(() => {
  for (const ws of sockets) ws.terminate();
});

// ---------- game helpers & payload checks ----------
const rid = () => `e2e-${tag(8)}`;

async function createGame(c, { categories = [LOAD_CATEGORY], count = 1, hostPlays = false, requestId = rid() } = {}) {
  const ack = await c.send('game:create', { categories, count, hostPlays, requestId });
  assert.equal(ack.ok, true, `${c.label}: game:create failed: ${ack.error}`);
  assert.match(ack.code, CODE_RE);
  assert.equal(ack.snapshot?.code, ack.code);
  assert.ok(Number.isInteger(ack.snapshot.v), 'snapshots carry v');
  return ack;
}

async function joinOk(c, code) {
  const ack = await c.send('room:join', { code });
  assert.equal(ack.ok, true, `${c.label}: room:join failed: ${ack.error}`);
  assert.equal(ack.snapshot?.code, code.toUpperCase());
  assert.equal(ack.snapshot.isPlayer, true);
  assert.ok(Array.isArray(ack.snapshot.players) && ack.snapshot.players.length <= 24, 'a player sees at most 24 names');
  return ack;
}

/** Did the snapshot's viewer already answer the open question? (`answered` may sit in `question` or next to it.) */
const answeredFlag = (s) => s?.question?.answered ?? s?.answered;

function assertShow(q, { code, index, total, playerCount }) {
  assert.equal(q.code, code);
  assert.equal(q.index, index);
  assert.equal(q.total, total);
  assert.ok(Number.isInteger(q.v), 'question:show carries v');
  assert.equal(typeof q.text, 'string');
  assert.ok(Array.isArray(q.options) && q.options.length >= 2);
  assert.ok(q.timeLimit > 0);
  assert.ok(Number.isFinite(q.endsAt) && Number.isFinite(q.acceptUntil) && q.acceptUntil >= q.endsAt, 'endsAt <= acceptUntil');
  assert.ok(Number.isFinite(q.serverNow));
  if (playerCount !== undefined) assert.equal(q.playerCount, playerCount);
  assert.equal(q.correctIndex, undefined, 'the answer must not leak before the reveal');
}

function assertLocked(ack, k) {
  assert.equal(ack.ok, true, `answer refused: ${ack.error}`);
  assert.equal(ack.locked, true);
  if (ack.index !== undefined) assert.equal(ack.index, k);
}

function assertResult(r, { code, index, total, playerCount, answeredCount, show }) {
  assert.equal(r.code, code);
  assert.equal(r.index, index);
  assert.equal(r.total, total);
  assert.ok(Number.isInteger(r.v), 'question:result carries v');
  if (show) {
    assert.equal(r.text, show.text);
    assert.deepEqual(r.options, show.options);
    assert.ok(r.v > show.v, 'the reveal is newer than its question');
    if (correctOptionOf(show) >= 0) assert.equal(r.correctIndex, correctOptionOf(show), 'the right option is revealed');
  }
  assert.ok(Number.isInteger(r.correctIndex) && r.correctIndex >= 0 && r.correctIndex < r.options.length);
  assert.ok(Array.isArray(r.optionCounts) && r.optionCounts.length === r.options.length);
  assert.equal(r.optionCounts.reduce((s, n) => s + n, 0), r.answeredCount, 'optionCounts add up to answeredCount');
  if (answeredCount !== undefined) assert.equal(r.answeredCount, answeredCount);
  if (playerCount !== undefined) assert.equal(r.playerCount, playerCount);
  assert.ok(Number.isFinite(r.revealEndsAt) && Number.isFinite(r.serverNow));
  assert.ok(Array.isArray(r.leaderboard) && r.leaderboard.length <= 10);
  assert.deepEqual(rankProblems(r.leaderboard), []);
  assert.ok('me' in r && 'myChoice' in r, 'question:result has me and myChoice (null for a presenter)');
}

function assertMyChoice(r, choice) {
  assert.ok(r.myChoice, "a player's result says what they answered");
  assert.equal(r.myChoice.choice, choice);
  assert.equal(r.myChoice.correct, choice === r.correctIndex);
  if (r.myChoice.correct) assert.ok(r.myChoice.gained > 0, 'a right answer scores');
  else assert.equal(r.myChoice.gained, 0, 'a wrong answer scores nothing');
}

function assertEnd(e, { code, playerCount }) {
  assert.equal(e.code, code);
  assert.ok(Number.isInteger(e.v), 'game:end carries v');
  assert.equal(e.playerCount, playerCount);
  assert.ok(Array.isArray(e.leaderboard));
  assert.equal(e.leaderboard.length, Math.min(10, playerCount));
  assert.deepEqual(rankProblems(e.leaderboard), []);
  assert.ok('me' in e);
}

/** Phase events of one game on one socket, in arrival order: versions only go up (and lobby lists are older). */
function assertVersionsIncrease(c, code) {
  const phases = c.events.filter((e) => PHASE_EVENTS.has(e.event) && e.data?.code === code);
  for (let i = 1; i < phases.length; i++) {
    const [a, b] = [phases[i - 1], phases[i]];
    assert.ok(b.data.v > a.data.v, `${c.label}: ${b.event} (v=${b.data.v}) arrived after ${a.event} (v=${a.data.v})`);
  }
  const lobbyVs = c.all('room:state', (s) => s.code === code).map((s) => s.v);
  if (phases.length && lobbyVs.length) assert.ok(Math.max(...lobbyVs) < phases[0].data.v, 'room:state is older than every phase');
  return phases.map((e) => e.event);
}

let statsAtStart = null;
before(async () => {
  const health = await api('/api/health').catch((err) => ({ status: 0, body: { error: err.cause?.code || err.message } }));
  if (health.status !== 200) {
    throw new Error(`no Quibble API at ${API} (${health.status || JSON.stringify(health.body)}): start it with npm run dev, or set QA_API / QA_WS`);
  }
  statsAtStart = await localStats();
});

// ---------- tests ----------
test('a socket with a bad token is rejected', async () => {
  await assert.rejects(Client.connect({ token: 'nope', username: 'nobody' }), /socket rejected: HTTP 4\d\d/);
});

test('REST: register, me, validation, wrong password; a sign-up clash names the field', async () => {
  const username = `rest_${tag(4)}`;
  const body = { email: `${username}@e2e.test`, username, password: PASSWORD };
  const reg = await api('/api/auth/register', { method: 'POST', body });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  assert.equal(typeof reg.body.token, 'string');
  const u = reg.body.user;
  assert.ok(u.id);
  assert.equal(u.username, username);
  assert.equal(u.email, body.email);
  assert.equal(u.role, 'player');
  assert.equal(u.passwordHash, undefined);

  const me = await api('/api/auth/me', { token: reg.body.token });
  assert.equal(me.status, 200);
  assert.equal(me.body.user.id, u.id);
  assert.equal((await api('/api/auth/me')).status, 401);
  assert.equal((await api('/api/auth/me', { token: 'not-a-token' })).status, 401);

  const bad = await api('/api/auth/register', { method: 'POST', body: { email: 'x', username: 'a', password: '1' } });
  assert.equal(bad.status, 400);
  assert.equal(typeof bad.body.error, 'string');

  // The page logs in on a 409 for the email (an earlier attempt may have worked) and shows "taken" for the username.
  const dupEmail = await api('/api/auth/register', { method: 'POST', body: { ...body, username: `rest_${tag(4)}` } });
  assert.equal(dupEmail.status, 409);
  assert.equal(dupEmail.body.field, 'email');
  assert.equal(typeof dupEmail.body.error, 'string');
  const dupName = await api('/api/auth/register', {
    method: 'POST', body: { ...body, email: `rest_${tag(4)}@e2e.test`, username: username.toUpperCase() },
  });
  assert.equal(dupName.status, 409, 'usernames are unique regardless of case');
  assert.equal(dupName.body.field, 'username');

  const wrong = await api('/api/auth/login', { method: 'POST', body: { email: body.email, password: 'wrong-password' } });
  assert.equal(wrong.status, 401);
  const login = await api('/api/auth/login', { method: 'POST', body: { email: body.email, password: PASSWORD } });
  assert.equal(login.status, 200);
  assert.equal(login.body.user.id, u.id);

  const cats = await api('/api/categories');
  assert.equal(cats.status, 200);
  assert.ok(cats.body.categories.length > 0);
});

test('hello: protocol check, profile in the ack, ping, no-ops outside a game', async (t) => {
  const u = await register('hello');
  const c = await connect(t, u);
  const old = await c.send('hello', {});
  assert.equal(old.ok, true, old.error);
  assert.equal(old.reload, true, 'a page without protocol 3 is told to reload');
  assert.equal((await c.send('hello', { protocol: 1 })).reload, true);

  const ack = await c.hello();
  assert.equal(ack.inGame, false);
  assert.equal(ack.snapshot, undefined);
  assert.equal(ack.user.username, u.username);
  assert.equal(ack.token, undefined, 'a token is only refreshed once it is older than 24 h');
  const sync = await c.hello('sync');
  assert.equal(sync.inGame, false);

  const ping = await c.send('ping', {});
  assert.equal(ping.ok, true);
  assert.ok(Math.abs(ping.serverNow - Date.now()) < 60_000, 'ping acks carry serverNow');

  const answer = await c.send('answer:submit', { choice: 0 });
  assert.equal(answer.ok, false);
  assert.equal(answer.error, "You're not playing in a game.");
  assert.equal((await c.send('game:start', {})).ok, false);
  assert.equal((await c.send('room:leave', {})).ok, true, 'leaving without a game is a no-op');
  assert.equal((await c.send('game:cancel', {})).ok, true, 'cancelling without a game is a no-op');
  assert.equal((await c.send('no:such:action', {})).ok, false);
  assert.equal((await c.send('room:join', { code: 'ZZZZZZ' })).error, 'No game with that code.');
});

test('full game: two players, early close when everyone answered, versions only increase, results saved', { timeout: 120_000 }, async (t) => {
  await loadReady();
  const [alice, bob] = await Promise.all([register('alice'), register('bob')]);
  const a = await connect(t, alice);
  const b = await connect(t, bob);
  await a.hello();
  await b.hello();

  const created = await createGame(a, { count: 3, hostPlays: true });
  const code = created.code;
  const s0 = created.snapshot;
  assert.equal(s0.status, 'lobby');
  assert.equal(s0.hostId, alice.id);
  assert.equal(s0.hostName, alice.username);
  assert.equal(s0.hostPlays, true);
  assert.equal(s0.category, LOAD_CATEGORY);
  assert.equal(s0.total, 3);
  assert.equal(s0.isPlayer, true);
  assert.equal(s0.playerCount, 1);
  assert.deepEqual(s0.players.map((p) => p.userId), [alice.id]);

  const joined = await joinOk(b, code.toLowerCase()); // codes are case-insensitive
  assert.equal(joined.snapshot.status, 'lobby');
  assert.equal(joined.snapshot.playerCount, 2);
  assert.ok(joined.snapshot.players.some((p) => p.userId === bob.id));
  assert.equal((await joinOk(b, code)).snapshot.code, code, 'joining again is a rejoin');

  const lobby = await a.next('room:state', (s) => s.playerCount === 2, 10_000);
  assert.equal(lobby.code, code);
  assert.equal(lobby.status, 'lobby');
  assert.equal(lobby.hostId, alice.id);
  assert.equal(lobby.total, 3);
  assert.deepEqual(new Set(lobby.players.map((p) => p.userId)), new Set([alice.id, bob.id]));
  assert.ok(lobby.players.every((p) => p.connected === true));

  assert.equal((await b.send('game:start', {})).ok, false, 'only the host can start');
  const starts = await Promise.all([a.send('game:start', {}), a.send('game:start', {})]);
  for (const s of starts) assert.equal(s.ok, true, `start (twice at once) failed: ${s.error}`);
  assert.equal((await a.send('game:start', {})).ok, true, 'starting a started game is a no-op');

  const score = { [alice.id]: 0, [bob.id]: 0 };
  const rights = { [alice.id]: 0, [bob.id]: 0 };
  for (let k = 0; k < 3; k++) {
    const qa = await a.next('question:show', (q) => q.index === k, 15_000);
    const qb = await b.next('question:show', (q) => q.index === k, 15_000);
    assertShow(qa, { code, index: k, total: 3, playerCount: 2 });
    assert.equal(qb.text, qa.text);
    assert.equal(qb.v, qa.v);
    assert.equal(qb.endsAt, qa.endsAt);
    const right = Math.max(0, correctOptionOf(qa));
    const wrong = (right + 1) % qa.options.length;
    const acks = await Promise.all([
      a.send('answer:submit', { code, index: k, choice: right }),
      b.send('answer:submit', { code, index: k, choice: wrong }),
    ]);
    for (const ack of acks) assertLocked(ack, k);

    const ra = await a.next('question:result', (r) => r.index === k, 10_000);
    const rb = await b.next('question:result', (r) => r.index === k, 10_000);
    assertResult(ra, { code, index: k, total: 3, playerCount: 2, answeredCount: 2, show: qa });
    assert.ok(ra.serverNow < qa.endsAt, `question ${k + 1} closes as soon as both answered, not by its timer`);
    assert.equal(rb.v, ra.v);
    assert.deepEqual(rb.optionCounts, ra.optionCounts);
    assert.deepEqual(rb.leaderboard, ra.leaderboard);
    assert.equal(ra.optionCounts[right], 1);
    assert.equal(ra.optionCounts[wrong], 1);
    assertMyChoice(ra, right);
    assertMyChoice(rb, wrong);
    score[alice.id] += ra.myChoice.gained;
    score[bob.id] += rb.myChoice.gained;
    rights[alice.id] += ra.myChoice.correct ? 1 : 0;
    rights[bob.id] += rb.myChoice.correct ? 1 : 0;
    assert.equal(ra.me?.userId, alice.id);
    assert.equal(ra.me.score, score[alice.id]);
    assert.equal(rb.me?.userId, bob.id);
    assert.equal(rb.me.score, score[bob.id]);
  }

  const ea = await a.next('game:end', (e) => e.code === code, 15_000);
  const eb = await b.next('game:end', (e) => e.code === code, 15_000);
  assertEnd(ea, { code, playerCount: 2 });
  assert.deepEqual(eb.leaderboard, ea.leaderboard);
  assert.equal(ea.me?.userId, alice.id);
  assert.equal(ea.me.score, score[alice.id]);
  assert.equal(eb.me?.userId, bob.id);
  assert.equal(eb.me.score, score[bob.id]);
  for (const row of ea.leaderboard) {
    assert.equal(row.score, score[row.userId]);
    assert.equal(row.correctCount, rights[row.userId]);
  }
  if (rights[alice.id] === 3) assert.deepEqual(ea.leaderboard.map((r) => r.userId), [alice.id, bob.id], 'the right answers win');

  // Every phase arrived exactly once per socket, with versions that only go up.
  const order = ['question:show', 'question:result', 'question:show', 'question:result', 'question:show', 'question:result', 'game:end'];
  assert.deepEqual(assertVersionsIncrease(a, code), order);
  assert.deepEqual(assertVersionsIncrease(b, code), order);

  // Results are saved.
  for (const [user, end] of [[alice, ea], [bob, eb]]) {
    const hist = await call('/api/me/history', { token: user.token });
    assert.equal(hist.games[0]?.code, code);
    assert.equal(hist.games[0].score, end.me.score);
    assert.equal(hist.games[0].rank, end.me.rank);
    assert.equal(hist.games[0].questionCount, 3);
    assert.equal(hist.games[0].playerCount, 2);
    assert.equal(hist.totals.gamesPlayed, 1);
  }
  assert.equal((await api('/api/leaderboard?period=week')).status, 200);

  // After the game you can host a new one (currentGame was cleared).
  assert.equal((await a.hello()).inGame, false);
  const again = await createGame(a, { count: 1 });
  assert.notEqual(again.code, code);
  assert.equal((await a.send('game:cancel', {})).ok, true);
});

test('the timer closes a question nobody answered; hello restores the game after a reconnect', { timeout: 90_000 }, async (t) => {
  await loadReady();
  const [hostUser, pu] = await Promise.all([register('timerh'), register('timerp')]);
  const h = await connect(t, hostUser);
  await h.hello();
  const { code, snapshot } = await createGame(h, { count: 1, hostPlays: false });
  assert.equal(snapshot.isPlayer, false, 'a presenter host does not play');
  assert.equal(snapshot.playerCount, 0);
  let c = await connect(t, pu);
  await c.hello();
  await joinOk(c, code);
  assert.equal((await h.send('game:start', {})).ok, true);
  const q = await c.next('question:show', (x) => x.code === code, 10_000);
  assertShow(q, { code, index: 0, total: 1, playerCount: 1 });

  // The player's tab reloads mid-question: a new socket, and hello hands back the open question.
  c.drop();
  await sleep(300);
  c = await connect(t, pu);
  const back = await c.hello();
  assert.equal(back.inGame, true);
  const s = back.snapshot;
  assert.equal(s.code, code);
  assert.equal(s.status, 'question');
  assert.equal(s.v, q.v);
  assert.equal(s.isPlayer, true);
  assert.equal(s.total, 1);
  assert.equal(s.question.index, 0);
  assert.equal(s.question.text, q.text);
  assert.equal(s.question.endsAt, q.endsAt);
  assert.equal(s.question.correctIndex, undefined);
  assert.equal(answeredFlag(s), false);

  // Nobody answers: the GameTimer closes the question at its deadline.
  const r = await h.next('question:result', (x) => x.index === 0, q.timeLimit * 1000 + 20_000);
  assertResult(r, { code, index: 0, total: 1, playerCount: 1, answeredCount: 0, show: q });
  assert.ok(r.serverNow >= q.endsAt, 'closed by the timer, not early');
  assert.deepEqual(r.optionCounts, q.options.map(() => 0));
  assert.equal(r.me, null, 'a presenter has no row');
  assert.equal(r.myChoice, null);
  const mine = await c.next('question:result', (x) => x.index === 0, 10_000);
  assert.equal(mine.myChoice, null);
  assert.equal(mine.me?.userId, pu.id);
  assert.equal(mine.me.score, 0);

  // Reconnecting during the reveal: the snapshot carries the result (unless the reveal is already over).
  c.drop();
  c = await connect(t, pu);
  const mid = await c.hello();
  if (mid.inGame && mid.snapshot.status === 'reveal') {
    assert.equal(mid.snapshot.v, r.v);
    assert.equal(mid.snapshot.result.index, 0);
    assert.equal(mid.snapshot.result.correctIndex, r.correctIndex);
    assert.equal(mid.snapshot.result.myChoice, null);
  } else {
    t.diagnostic(`the reveal was over before the reconnect (inGame ${mid.inGame}, status ${mid.snapshot?.status})`);
  }

  const end = await h.next('game:end', (e) => e.code === code, 20_000);
  assertEnd(end, { code, playerCount: 1 });
  assert.equal(end.me, null);
  assert.equal(end.leaderboard[0].userId, pu.id);
  assert.equal(end.leaderboard[0].score, 0);
  assert.equal(end.leaderboard[0].rank, 1);
  const theirs = mid.final ?? (await c.next('game:end', (e) => e.code === code, 10_000));
  assert.equal(theirs.me?.score, 0);
  assert.equal(theirs.me.rank, 1);
  assert.deepEqual(assertVersionsIncrease(h, code), ['question:show', 'question:result', 'game:end']);

  const hist = await call('/api/me/history', { token: pu.token });
  const row = hist.games.find((g) => g.code === code);
  assert.ok(row, 'the game was saved');
  assert.equal(row.score, 0);
  assert.equal(row.rank, 1);
});

test('8 players answering at the same moment: no lost answers', { timeout: 60_000 }, async (t) => {
  await loadReady();
  const hostUser = await register('crowd');
  const users = await registerMany(8, 'crowd');
  const h = await connect(t, hostUser);
  await h.hello();
  const { code } = await createGame(h, { count: 1 });
  const clients = await Promise.all(users.map((u) => connect(t, u)));
  await Promise.all(clients.map((c) => c.hello()));
  await Promise.all(clients.map((c) => joinOk(c, code))); // all at once
  await h.next('room:state', (s) => s.playerCount === 8, 10_000);
  assert.equal((await h.send('game:start', {})).ok, true);

  const shows = await Promise.all(clients.map((c) => c.next('question:show', (q) => q.code === code, 10_000)));
  const acks = await Promise.all(clients.map((c, i) => c.send('answer:submit', { code, index: 0, choice: i % 4 })));
  for (const ack of acks) assertLocked(ack, 0);

  const result = await h.next('question:result', (r) => r.index === 0, 10_000);
  assertResult(result, { code, index: 0, total: 1, playerCount: 8, answeredCount: 8, show: shows[0] });
  assert.deepEqual(result.optionCounts, [2, 2, 2, 2]);
  assert.ok(result.serverNow < shows[0].endsAt, 'closes as soon as all 8 answered');
  assert.equal(result.me, null);
  assert.equal(result.myChoice, null);
  const mine = await Promise.all(clients.map((c) => c.next('question:result', (r) => r.index === 0, 10_000)));
  mine.forEach((r, i) => assertMyChoice(r, i % 4));

  const end = await h.next('game:end', (e) => e.code === code, 15_000);
  assertEnd(end, { code, playerCount: 8 });
  assert.equal(end.leaderboard.filter((r) => r.score > 0).length, 2, 'the two who picked the right option scored');
});

test('a duplicate answer is idempotent: ok + locked, counted once, the first choice kept', { timeout: 60_000 }, async (t) => {
  await loadReady();
  const [hostUser, u1, u2] = await Promise.all([register('duph'), register('dup1'), register('dup2')]);
  const h = await connect(t, hostUser);
  const p1 = await connect(t, u1);
  const p2 = await connect(t, u2);
  await Promise.all([h.hello(), p1.hello(), p2.hello()]);
  const { code } = await createGame(h, { count: 1 });
  await joinOk(p1, code);
  await joinOk(p2, code);
  const p1b = await connect(t, u1, `${u1.username}-tab2`); // a second tab of player 1
  const hb = await p1b.hello();
  assert.equal(hb.inGame, true);
  assert.equal(hb.snapshot.code, code);
  assert.equal((await h.send('game:start', {})).ok, true);

  const q = await p1.next('question:show', (x) => x.code === code, 10_000);
  await p1b.next('question:show', (x) => x.code === code, 10_000); // every tab of a member gets the pushes
  const first = Math.max(0, correctOptionOf(q));
  const other = (first + 1) % q.options.length;
  const third = (first + 2) % q.options.length;

  const burst = await Promise.all([
    p1.send('answer:submit', { code, index: 0, choice: first }),
    p1.send('answer:submit', { code, index: 0, choice: first }),
  ]);
  for (const ack of burst) assertLocked(ack, 0);
  assertLocked(await p1.send('answer:submit', { code, index: 0, choice: other }), 0);
  assertLocked(await p1b.send('answer:submit', { code, index: 0, choice: other }), 0);
  assert.equal(answeredFlag((await p1b.hello('sync')).snapshot), true, 'the snapshot says player 1 has answered');

  // The question timer pushes "x / y answered" about once a second: player 1 counts once.
  const count = await h.next('answer:count', (x) => x.code === code && x.answered > 0, 4000);
  assert.equal(count.index, 0);
  assert.equal(count.answered, 1);
  assert.equal(count.total, 2);
  assert.equal(count.v, q.v);

  assertLocked(await p2.send('answer:submit', { code, index: 0, choice: third }), 0);
  const r = await p1.next('question:result', (x) => x.index === 0, 10_000);
  assertResult(r, { code, index: 0, total: 1, playerCount: 2, answeredCount: 2, show: q });
  assert.equal(r.optionCounts[first], 1);
  assert.equal(r.optionCounts[other], 0);
  assert.equal(r.optionCounts[third], 1);
  assertMyChoice(r, first);
  assertMyChoice(await p1b.next('question:result', (x) => x.index === 0, 10_000), first);
  assertMyChoice(await p2.next('question:result', (x) => x.index === 0, 10_000), third);
  for (const c of [h, p1, p1b, p2]) {
    for (const n of c.all('answer:count', (x) => x.code === code)) assert.ok(n.answered <= 2, `answer:count says ${n.answered}`);
  }
  // Still acknowledged after the close: the answer was counted.
  assertLocked(await p1.send('answer:submit', { code, index: 0, choice: first }), 0);
});

test('an answer resent after its socket closed before the ack is counted once', { timeout: 60_000 }, async (t) => {
  await loadReady();
  const [hostUser, u1, u2] = await Promise.all([register('resh'), register('res1'), register('res2')]);
  const h = await connect(t, hostUser);
  const p1 = await connect(t, u1);
  const p2 = await connect(t, u2);
  await Promise.all([h.hello(), p1.hello(), p2.hello()]);
  const { code } = await createGame(h, { count: 1 });
  await joinOk(p1, code);
  await joinOk(p2, code);
  assert.equal((await h.send('game:start', {})).ok, true);
  const q = await p1.next('question:show', (x) => x.code === code, 10_000);
  await p2.next('question:show', (x) => x.code === code, 10_000);

  // The answer goes out and the connection dies before its ack comes back (the ack is lost with the socket).
  const choice = Math.max(0, correctOptionOf(q));
  const id = 4242;
  p1.sendAndDrop(id, 'answer:submit', { code, index: 0, choice });
  await sleep(500);

  // Like realtime.js after a reconnect: the pending message goes out again (same id) on the new socket, then hello.
  const p1b = await connect(t, u1, `${u1.username}-again`);
  assertLocked(await p1b.send('answer:submit', { code, index: 0, choice }, { id }), 0);
  const back = await p1b.hello();
  assert.equal(back.inGame, true);
  assert.equal(back.snapshot.status, 'question');
  assert.equal(answeredFlag(back.snapshot), true);
  assertLocked(await p1b.send('answer:submit', { code, index: 0, choice: (choice + 1) % q.options.length }), 0);

  assertLocked(await p2.send('answer:submit', { code, index: 0, choice }), 0);
  const r = await h.next('question:result', (x) => x.index === 0, 15_000);
  assertResult(r, { code, index: 0, total: 1, playerCount: 2, answeredCount: 2, show: q });
  assert.equal(r.optionCounts[choice], 2, 'player 1 counted once, with the first choice');
  assertMyChoice(await p1b.next('question:result', (x) => x.index === 0, 10_000), choice);
});

test('room:state: the presenter host sees every player, players see the 24 most recent joiners', { timeout: 120_000 }, async (t) => {
  await loadReady();
  const N = 26;
  const hostUser = await register('lobbyh');
  const users = await registerMany(N, 'lobby');
  const h = await connect(t, hostUser);
  await h.hello();
  const { code, snapshot } = await createGame(h, { count: 1, hostPlays: false });
  assert.equal(snapshot.isPlayer, false);
  assert.equal(snapshot.playerCount, 0);
  assert.deepEqual(snapshot.players, []);
  const clients = await Promise.all(users.map((u) => connect(t, u)));
  await Promise.all(clients.map((c) => c.hello()));
  for (const c of clients) {
    const ack = await joinOk(c, code); // one at a time, so seats follow the join order
    assert.ok(ack.snapshot.players.some((p) => p.userId === c.user.id), 'the join snapshot lists the joiner');
  }

  const full = await h.next('room:state', (s) => s.playerCount === N && s.players.length === N, 15_000);
  assert.equal(full.code, code);
  assert.equal(full.status, 'lobby');
  assert.equal(full.hostId, hostUser.id);
  assert.equal(full.hostPlays, false);
  assert.ok(Number.isInteger(full.v));
  assert.deepEqual(new Set(full.players.map((p) => p.userId)), new Set(users.map((u) => u.id)));
  assert.ok(full.players.every((p) => p.username && p.connected === true));

  const newest = users.slice(-24).reverse().map((u) => u.id);
  for (const c of [clients[0], clients[N - 1]]) {
    const s = await c.next('room:state', (x) => x.playerCount === N, 15_000);
    assert.equal(s.players.length, 24, 'players see 24 names');
    assert.deepEqual(s.players.map((p) => p.userId), newest, 'the 24 most recent joiners, newest first');
  }
  for (const c of clients) for (const s of c.all('room:state')) assert.ok(s.players.length <= 24, `${c.label} got ${s.players.length} names`);
  assert.ok(h.all('room:state').length > 0);

  // Snapshots follow the same rule.
  const hs = await h.hello('sync');
  assert.equal(hs.snapshot.status, 'lobby');
  assert.equal(hs.snapshot.players.length, N, "the host's snapshot lists everybody");
  const ps = await clients[0].hello('sync');
  assert.ok(ps.snapshot.players.length <= 24);
  assert.equal(ps.snapshot.playerCount, N);
  assert.equal((await h.send('game:cancel', {})).ok, true);
});

test('game:create resent with the same requestId returns the same game', { timeout: 60_000 }, async (t) => {
  await loadReady();
  const u = await register('create');
  const c = await connect(t, u);
  await c.hello();
  const data = { categories: [LOAD_CATEGORY], count: 2, hostPlays: false, requestId: rid() };
  const [x, y] = await Promise.all([c.send('game:create', data), c.send('game:create', data)]);
  assert.equal(x.ok, true, x.error);
  assert.equal(y.ok, true, y.error);
  assert.match(x.code, CODE_RE);
  assert.equal(y.code, x.code, 'two concurrent sends of one create make one game');
  const z = await c.send('game:create', data);
  assert.equal(z.ok, true, z.error);
  assert.equal(z.code, x.code);
  assert.equal(z.snapshot.code, x.code);
  assert.equal(z.snapshot.status, 'lobby');
  const tab2 = await connect(t, u, `${u.username}-tab2`);
  const w = await tab2.send('game:create', data);
  assert.equal(w.ok, true, w.error);
  assert.equal(w.code, x.code, 'the same request from another tab too');

  const other = await c.send('game:create', { ...data, requestId: rid() });
  assert.equal(other.ok, false, 'a new create while hosting is refused');
  assert.equal(other.error, "You're already in a game. Leave it first.");
  const hello = await c.hello();
  assert.equal(hello.inGame, true);
  assert.equal(hello.snapshot.code, x.code);

  assert.equal((await c.send('game:cancel', {})).ok, true);
  const fresh = await createGame(c, { count: 1 });
  assert.notEqual(fresh.code, x.code);
  assert.equal((await c.send('game:cancel', {})).ok, true);
});

test('leave and cancel are idempotent; a cancelled game stays cancelled', { timeout: 60_000 }, async (t) => {
  await loadReady();
  const [hostUser, u1, u2] = await Promise.all([register('cxh'), register('cx1'), register('cx2')]);
  const h = await connect(t, hostUser);
  const p1 = await connect(t, u1);
  const p2 = await connect(t, u2);
  await Promise.all([h.hello(), p1.hello(), p2.hello()]);
  const { code, snapshot } = await createGame(h, { count: 1 });
  await joinOk(p1, code);
  await joinOk(p2, code);
  await h.next('room:state', (s) => s.playerCount === 2, 10_000);

  // Leaving twice: the second is a no-op.
  h.flush('room:state');
  const l1 = await p1.send('room:leave', {});
  assert.equal(l1.ok, true, l1.error);
  const l2 = await p1.send('room:leave', {});
  assert.equal(l2.ok, true, `a second leave is a no-op: ${l2.error}`);
  assert.equal((await p1.hello()).inGame, false);
  const left = await h.next('room:state', (s) => s.playerCount === 1, 10_000);
  assert.deepEqual(left.players.map((p) => p.userId), [u2.id]);
  await joinOk(p1, code); // back in while the lobby is open
  await h.next('room:state', (s) => s.playerCount === 2, 10_000);

  // Only the host cancels; cancelling twice (even at once) is fine, and everyone hears about it once.
  assert.equal((await p2.send('game:cancel', {})).ok, false);
  const cancels = await Promise.all([h.send('game:cancel', {}), h.send('game:cancel', {})]);
  for (const ack of cancels) assert.equal(ack.ok, true, ack.error);
  assert.equal((await h.send('game:cancel', {})).ok, true);
  for (const c of [h, p1, p2]) {
    const ev = await c.next('game:cancelled', (e) => e.code === code, 10_000);
    assert.equal(typeof ev.reason, 'string');
    assert.ok(ev.v > snapshot.v);
  }
  await sleep(1000);
  for (const c of [h, p1, p2]) assert.equal(c.all('game:cancelled', (e) => e.code === code).length, 1, `${c.label}: game:cancelled once`);
  assert.equal((await p1.send('room:join', { code })).error, 'That game was cancelled.');
  assert.equal((await p2.hello()).inGame, false);
  assert.equal((await p2.send('room:leave', {})).ok, true);

  // In a running game players can't leave, and the host leaving cancels it.
  const g2 = await createGame(h, { count: 1 });
  await joinOk(p1, g2.code);
  assert.equal((await h.send('game:start', {})).ok, true);
  await p1.next('question:show', (q) => q.code === g2.code, 10_000);
  const stay = await p1.send('room:leave', {});
  assert.equal(stay.ok, false);
  assert.equal(stay.error, "You can't leave a game that's in progress.");
  assert.equal((await h.send('room:leave', {})).ok, true, 'the host leaving cancels the game');
  const ev = await p1.next('game:cancelled', (e) => e.code === g2.code, 10_000);
  assert.equal(typeof ev.reason, 'string');
  assert.equal((await h.send('room:leave', {})).ok, true);
  assert.equal((await h.send('game:cancel', {})).ok, true);
  assert.equal((await p1.hello()).inGame, false);
});

test('admin: stats, question CRUD, a ban kicks a live socket out of its lobby', { timeout: 60_000 }, async (t) => {
  const token = await adminToken();
  const [victim, hostUser] = await Promise.all([register('victim'), register('victimh')]);
  assert.equal((await api('/api/admin/stats', { token: victim.token })).status, 403);
  assert.equal((await api('/api/admin/stats')).status, 401);
  const stats = await api('/api/admin/stats', { token });
  assert.equal(stats.status, 200);
  assert.ok(stats.body.totals.questions > 0);
  assert.ok(Number.isInteger(stats.body.liveGames));

  const category = `E2E ${tag(3)}`;
  const q = { text: 'Test question?', options: ['a', 'b'], correctIndex: 1, category, timeLimit: 10 };
  const created = await api('/api/admin/questions', { method: 'POST', token, body: q });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.question.id;
  const listed = await api(`/api/admin/questions?category=${encodeURIComponent(category)}`, { token });
  assert.deepEqual(listed.body.questions.map((x) => x.id), [id]);
  const badPut = await api(`/api/admin/questions/${id}`, { method: 'PUT', token, body: { ...q, correctIndex: 5 } });
  assert.equal(badPut.status, 400);
  const updated = await api(`/api/admin/questions/${id}`, { method: 'PUT', token, body: { ...q, text: 'Edited?', options: ['a', 'b', 'c'], correctIndex: 2 } });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.question.text, 'Edited?');
  assert.equal(updated.body.question.correctIndex, 2);
  assert.equal((await api(`/api/admin/questions/${id}`, { method: 'DELETE', token })).status, 200);
  assert.equal((await api(`/api/admin/questions/${id}`, { method: 'DELETE', token })).status, 404);

  // A banned player waiting in a lobby: socket closed, seat given back, token dead.
  await loadReady();
  const h = await connect(t, hostUser);
  await h.hello();
  const { code } = await createGame(h, { count: 1 });
  const v = await connect(t, victim);
  await v.hello();
  await joinOk(v, code);
  await h.next('room:state', (s) => s.playerCount === 1, 10_000);
  h.flush('room:state');
  const ban = await api(`/api/admin/users/${victim.id}`, { method: 'PATCH', token, body: { banned: true } });
  assert.equal(ban.status, 200, JSON.stringify(ban.body));
  assert.equal(ban.body.user.banned, true);
  const closed = await Promise.race([v.closed, sleep(10_000).then(() => null)]);
  assert.ok(closed, "the banned player's socket was closed");
  const lobby = await h.next('room:state', (s) => s.playerCount === 0, 10_000);
  assert.deepEqual(lobby.players, []);
  assert.equal((await api('/api/auth/me', { token: victim.token })).status, 401);
  await assert.rejects(Client.connect(victim, 'banned'), /socket rejected: HTTP 4\d\d/);
  const login = await api('/api/auth/login', { method: 'POST', body: { email: victim.email, password: PASSWORD } });
  assert.equal(login.status, 403);
  assert.equal((await h.send('game:cancel', {})).ok, true);
});

test('a game can draw from several categories', async (t) => {
  const u = await register('multi');
  const h = await connect(t, u);
  await h.hello();
  const { categories } = (await api('/api/categories')).body;
  const picked = categories.filter((c) => c.category !== LOAD_CATEGORY && !c.category.startsWith('E2E ')).slice(0, 2);
  assert.equal(picked.length, 2, 'needs two seeded categories');
  const pool = picked.reduce((n, c) => n + c.count, 0);

  const bad = await h.send('game:create', { categories: ['No Such Category'], count: 5, hostPlays: false, requestId: rid() });
  assert.equal(bad.ok, false);

  const created = await createGame(h, { categories: picked.map((c) => c.category), count: 30 });
  assert.equal(created.snapshot.total, Math.min(30, pool), 'questions only come from the picked categories');
  assert.equal(created.snapshot.category, picked.map((c) => c.category).join(', '));
  assert.equal((await h.send('game:cancel', {})).ok, true);
});

test(`the ${SPEC_MAX_PLAYERS + 1}st join gets "That game is full."`, {
  timeout: 600_000,
  skip: process.env.QA_SKIP_FULL === '1' ? 'QA_SKIP_FULL=1' : false,
}, async (t) => {
  await loadReady();
  const limit = MAX_PLAYERS ?? SPEC_MAX_PLAYERS;
  const hostUser = await register('fullh');
  const h = await connect(t, hostUser);
  await h.hello();
  const { code } = await createGame(h, { count: 1, hostPlays: false });

  // Join in waves of 50 until someone is turned away: the number seated is the server's MAX_PLAYERS.
  const seated = [];
  const refused = [];
  while (!refused.length && seated.length < limit + 1) {
    const users = await registerMany(Math.min(50, limit + 1 - seated.length), 'full');
    const clients = await Promise.all(users.map((u) => connect(t, u)));
    const acks = await Promise.all(clients.map((c) => c.send('room:join', { code })));
    acks.forEach((ack, i) => (ack.ok ? seated : refused).push({ c: clients[i], ack }));
  }
  assert.ok(refused.length, `${seated.length} players joined and nobody was turned away`);
  for (const { ack } of refused) assert.equal(ack.error, 'That game is full.');
  const max = seated.length;
  if (MAX_PLAYERS) assert.equal(max, MAX_PLAYERS, 'QA_MAX_PLAYERS');
  else {
    assert.ok(max <= SPEC_MAX_PLAYERS, `the game took ${max} players`);
    if (max < SPEC_MAX_PLAYERS) t.diagnostic(`the server's MAX_PLAYERS looks lowered to ${max} (QA_MAX_PLAYERS=${max} asserts it)`);
  }
  const lobby = await h.next('room:state', (s) => s.playerCount === max && s.players.length === max, 20_000);
  assert.equal(new Set(lobby.players.map((p) => p.userId)).size, max);

  // A seated player joining again is a rejoin (no new seat); a newcomer is still turned away.
  const outsider = refused[0].c;
  assert.equal((await seated[0].c.send('room:join', { code })).ok, true);
  assert.equal((await outsider.send('room:join', { code })).error, 'That game is full.');
  // One leaves: exactly one seat frees up.
  const leaver = seated[1].c;
  assert.equal((await leaver.send('room:leave', {})).ok, true);
  const inNow = await outsider.send('room:join', { code });
  assert.equal(inNow.ok, true, inNow.error);
  const late = refused[1]?.c ?? leaver;
  assert.equal((await late.send('room:join', { code })).error, 'That game is full.');
  await h.next('room:state', (s) => s.playerCount === max && s.players.some((p) => p.userId === outsider.user.id), 20_000);
  for (const { c } of seated.slice(0, 10)) for (const s of c.all('room:state')) assert.ok(s.players.length <= 24);
  assert.equal((await h.send('game:cancel', {})).ok, true);
});

test('an answer for a question that is not open yet does not lock the later answer', {
  todo: 'SPEC gap: submitAnswer writes the A# item before the gate check, so a premature answer is reused (choice and time) later',
  timeout: 60_000,
}, async (t) => {
  await loadReady();
  const [hostUser, u1, u2] = await Promise.all([register('earlyh'), register('early1'), register('early2')]);
  const h = await connect(t, hostUser);
  const p1 = await connect(t, u1);
  const p2 = await connect(t, u2);
  await Promise.all([h.hello(), p1.hello(), p2.hello()]);
  const { code } = await createGame(h, { count: 2 });
  await joinOk(p1, code);
  await joinOk(p2, code);
  assert.equal((await h.send('game:start', {})).ok, true);
  await p1.next('question:show', (q) => q.index === 0, 10_000);
  const early = await p1.send('answer:submit', { code, index: 1, choice: 3 });
  assert.equal(early.error, 'No question is open right now.');
  await Promise.all([p1.send('answer:submit', { code, index: 0, choice: 0 }), p2.send('answer:submit', { code, index: 0, choice: 0 })]);
  const q1 = await p1.next('question:show', (q) => q.index === 1, 20_000);
  const right = Math.max(0, correctOptionOf(q1));
  const pick = right === 3 ? 2 : right;
  await Promise.all([p1.send('answer:submit', { code, index: 1, choice: pick }), p2.send('answer:submit', { code, index: 1, choice: pick })]);
  const r = await p1.next('question:result', (x) => x.index === 1, 20_000);
  assertMyChoice(r, pick);
});

// ---------- My quizzes, question types, streaks, reactions, big screen ----------
const QUIZ = {
  title: 'E2E every type',
  description: 'one of each',
  shared: false,
  questions: [
    { type: 'choice', text: 'Pick B', options: ['A', 'B', 'C'], correctIndex: 1, timeLimit: 5 },
    { type: 'truefalse', text: 'Water is wet.', correctIndex: 0, timeLimit: 5 },
    { type: 'type', text: 'Capital of France?', answers: ['Paris'], timeLimit: 5 },
    { type: 'order', text: 'Count up', items: ['one', 'two', 'three', 'four'], timeLimit: 5 },
    { type: 'number', text: 'Bones in the body?', answer: 206, tolerance: 0, unit: 'bones', timeLimit: 5 },
  ],
};

test('My quizzes: create, list, privacy, sharing, edit, delete', async () => {
  const [owner, other] = await Promise.all([register('qowner'), register('qother')]);
  const bad = await api('/api/quizzes', { method: 'POST', token: owner.token, body: { ...QUIZ, questions: [{ type: 'order', text: 'Too few', items: ['a', 'b'] }] } });
  assert.equal(bad.status, 400);
  const created = await api('/api/quizzes', { method: 'POST', token: owner.token, body: QUIZ });
  assert.equal(created.status, 201);
  const { quiz } = created.body;
  assert.equal(quiz.questionCount, 5);
  assert.deepEqual(quiz.questions[1].options, ['True', 'False'], 'true/false questions get their two options');
  assert.equal((await api('/api/quizzes', { method: 'POST', body: QUIZ })).status, 401);

  const listed = (await api('/api/quizzes', { token: owner.token })).body.quizzes;
  assert.ok(listed.some((q) => q.id === quiz.id && q.questions === undefined), 'lists carry no questions');
  assert.equal((await api(`/api/quizzes/${quiz.id}`, { token: other.token })).status, 404, 'private quizzes are invisible to others');
  assert.equal((await api(`/api/quizzes/${quiz.id}`, { method: 'PUT', token: other.token, body: QUIZ })).status, 404);
  assert.equal((await api(`/api/quizzes/${quiz.id}`, { method: 'DELETE', token: other.token })).status, 404);

  const shared = await api(`/api/quizzes/${quiz.id}`, { method: 'PUT', token: owner.token, body: { ...QUIZ, title: 'Shared now', shared: true } });
  assert.equal(shared.status, 200);
  const seen = await api(`/api/quizzes/${quiz.id}`, { token: other.token });
  assert.equal(seen.status, 200);
  assert.equal(seen.body.quiz.title, 'Shared now');
  assert.equal(seen.body.quiz.questions, undefined, 'a shared quiz never shows its answers to others');
  assert.equal(seen.body.mine, false);

  assert.equal((await api(`/api/quizzes/${quiz.id}`, { method: 'DELETE', token: owner.token })).status, 200);
  assert.equal((await api(`/api/quizzes/${quiz.id}`, { token: owner.token })).status, 404);
});

test('a quiz game with every question type: typed answers, orders, numbers, streaks and reactions', { timeout: 120_000 }, async (t) => {
  const [hostUser, u1, u2] = await Promise.all([register('qhost'), register('qp1'), register('qp2')]);
  const { quiz } = (await api('/api/quizzes', { method: 'POST', token: hostUser.token, body: { ...QUIZ, shared: true } })).body;
  const h = await connect(t, hostUser);
  const p1 = await connect(t, u1);
  const p2 = await connect(t, u2);
  await Promise.all([h.hello(), p1.hello(), p2.hello()]);

  // A shared quiz can be hosted by someone else; big-screen mode forces the host out of the player list.
  const borrowed = await p2.send('game:create', { quizId: quiz.id, bigScreen: true, hostPlays: true, requestId: rid() });
  assert.equal(borrowed.ok, true, borrowed.error);
  assert.equal(borrowed.snapshot.bigScreen, true);
  assert.equal(borrowed.snapshot.hostPlays, false);
  assert.equal(borrowed.snapshot.quizTitle, QUIZ.title);
  assert.equal((await p2.send('game:cancel', {})).ok, true);

  const ack = await h.send('game:create', { quizId: quiz.id, bigScreen: true, doublePoints: true, requestId: rid() });
  assert.equal(ack.ok, true, ack.error);
  const { code } = ack;
  assert.equal(ack.snapshot.total, 5);
  await joinOk(p1, code);
  await joinOk(p2, code);

  // Reactions in the lobby: rate-limited per player, batched into one push.
  const r1 = await p1.send('react', { emoji: 2 });
  assert.equal(r1.ok, true);
  assert.equal(r1.sent, true);
  assert.equal((await p1.send('react', { emoji: 2 })).sent, false, 'a second tap right away is dropped');
  assert.equal((await p2.send('react', { emoji: 5 })).sent, true);
  assert.equal((await p1.send('react', { emoji: 9 })).ok, false, 'unknown emoji');
  const pushed = await h.next('reactions', (d) => d.code === code, 10_000);
  await sleep(1500);
  const total = h.all('reactions', (d) => d.code === code).reduce((acc, d) => acc.map((n, i) => n + (d.counts[i] || 0)), Array(8).fill(0));
  assert.equal(pushed.counts.length, 8);
  assert.equal(total[2], 1);
  assert.equal(total[5], 1);

  assert.equal((await h.send('game:start', {})).ok, true);
  // p1 answers everything right, p2 gets two wrong.
  const answersP1 = [{ choice: 1 }, { choice: 0 }, { text: 'paris' }, null, { value: 206 }];
  const answersP2 = [{ choice: 0 }, { choice: 0 }, { text: 'London' }, null, { value: 103 }];
  for (let k = 0; k < 5; k++) {
    const q = await p1.next('question:show', (x) => x.index === k, 20_000);
    assert.equal(q.type, QUIZ.questions[k].type);
    for (const key of ['correctIndex', 'correctOrder', 'answers', 'answer']) assert.equal(q[key], undefined, `question ${k} leaks ${key}`);
    if (k === 3) {
      // Order: the shown options are shuffled; answer with the right order (p1) and with two swapped (p2).
      const right = QUIZ.questions[3].items.map((item) => q.options.indexOf(item));
      answersP1[3] = { order: right };
      answersP2[3] = { order: [right[1], right[0], right[2], right[3]] };
      assert.notDeepEqual(q.options, QUIZ.questions[3].items, 'never shown in the right order');
      assert.equal((await p1.send('answer:submit', { code, index: k, choice: 0 })).error, 'Invalid option.', 'the answer must fit the type');
    }
    const [a1, a2] = await Promise.all([
      p1.send('answer:submit', { code, index: k, ...answersP1[k] }),
      p2.send('answer:submit', { code, index: k, ...answersP2[k] }),
    ]);
    assert.equal(a1.ok, true, `p1 q${k}: ${a1.error}`);
    assert.equal(a2.ok, true, `p2 q${k}: ${a2.error}`);
    const r = await p1.next('question:result', (x) => x.index === k, 20_000);
    assert.equal(r.myChoice.correct, true, `p1 got question ${k} right`);
    assert.equal(r.myChoice.streak, k + 1);
    assert.equal(r.myChoice.bonus, k >= 2 ? (k - 1) * 100 : 0, 'streak bonus from the 3rd in a row');
    assert.equal(r.double, k === 4, 'double points: the last question (the only one besides the first in a 5-question game)');
    assert.ok(r.answerText, 'the reveal says the answer');
    if (k === 2) {
      assert.equal(r.answerText, 'Paris');
      assert.deepEqual(r.summary.guesses.map((g) => g.correct).sort(), [false, true]);
      assert.equal(r.rightCount, 1);
      assert.equal(r.fastest?.username, u1.username);
    }
    if (k === 3) {
      const r2 = await p2.next('question:result', (x) => x.index === 3, 20_000);
      assert.equal(r2.myChoice.correct, false);
      assert.equal(r2.myChoice.partial, true, 'two of four in place is partly right');
      assert.equal(r2.myChoice.gained, 250);
    }
    if (k === 4) {
      assert.equal(r.summary.closest.username, u1.username);
      assert.equal(r.summary.average, 154.5);
      assert.ok(r.myChoice.gained >= 500 * 2 + 300, 'doubled points plus the 5-in-a-row bonus');
    }
  }
  const end = await p1.next('game:end', (d) => d.code === code, 30_000);
  assert.equal(end.me.rank, 1);
  assert.equal(end.awards.streak.username, u1.username);
  assert.equal(end.awards.streak.n, 5);
  // Reactions still fly on the final screen.
  assert.equal((await p2.send('react', { emoji: 0 })).sent, true);
  await p1.next('reactions', (d) => d.code === code && d.counts[0] >= 1, 10_000);
});

test('the bank can be filtered by question type', async (t) => {
  const u = await register('qtypes');
  const c = await connect(t, u);
  await c.hello();
  const cats = (await api('/api/categories', { token: u.token })).body;
  assert.ok(Array.isArray(cats.types) && cats.types.some((x) => x.type === 'truefalse' && x.count > 0), 'the seed has true/false questions');
  const ack = await c.send('game:create', { types: ['truefalse'], count: 3, hostPlays: true, requestId: rid() });
  assert.equal(ack.ok, true, ack.error);
  const none = await (async () => {
    await c.send('game:cancel', {});
    return c.send('game:create', { categories: [LOAD_CATEGORY], types: ['order'], count: 3, requestId: rid() });
  })();
  assert.equal(none.ok, false);
  assert.match(none.error, /types/);
});

test("the local server's handlers never crashed during these tests", async (t) => {
  if (!statsAtStart) return t.skip('no /__local/stats (not the local dev server)');
  const now = await localStats();
  assert.ok(now, '/__local/stats went away');
  const base = now.since === statsAtStart.since ? statsAtStart.errors || {} : {}; // reset meanwhile: count from the reset
  const crashed = Object.entries(now.errors || {}).filter(([fn, n]) => n > (base[fn] || 0)).map(([fn, n]) => `${fn} +${n - (base[fn] || 0)}`);
  assert.deepEqual(crashed, [], `handler runs threw (see the dev server log): ${crashed.join(', ')}`);
});
