// End-to-end tests against a running Quibble backend - the local emulator (npm run dev)
// or a real deployment:  QA_API=https://xxx.execute-api... QA_WS=wss://xxx... npm run test:e2e
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import WebSocket from 'ws';

const API = process.env.QA_API || 'http://localhost:5050';
const WS = process.env.QA_WS || 'ws://localhost:5050/ws';
const ADMIN = { email: process.env.ADMIN_EMAIL || 'admin@example.com', password: process.env.ADMIN_PASSWORD || 'admin12345' };

async function api(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

async function register(prefix) {
  const tag = crypto.randomBytes(3).toString('hex');
  const r = await api('/api/auth/register', { method: 'POST', body: { email: `${prefix}${tag}@test.dev`, username: `${prefix}_${tag}`, password: 'password123' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body.user, token: r.body.token };
}

/** A test client: send() returns the ack, next(event) waits for a server push. */
function connect(user) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS}?token=${encodeURIComponent(user.token)}`);
    const pending = new Map();
    const inbox = [];
    const waiters = [];
    let seq = 0;
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'ack') return pending.get(msg.id)?.(msg);
      const i = waiters.findIndex((w) => w.event === msg.event);
      if (i >= 0) waiters.splice(i, 1)[0].resolve(msg.data);
      else inbox.push(msg);
    });
    ws.on('error', reject);
    ws.on('unexpected-response', (_req, res) => reject(new Error(`rejected ${res.statusCode}`)));
    ws.on('open', () => resolve({
      ws,
      send(event, data = {}) {
        const id = ++seq;
        ws.send(JSON.stringify({ action: 'message', id, event, data }));
        return new Promise((res) => pending.set(id, res));
      },
      next(event, timeoutMs = 30000) {
        const i = inbox.findIndex((m) => m.event === event);
        if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0].data);
        return new Promise((res, rej) => {
          const t = setTimeout(() => rej(new Error(`timed out waiting for ${event}`)), timeoutMs);
          waiters.push({ event, resolve: (d) => { clearTimeout(t); res(d); } });
        });
      },
      drain(event) { for (let i = inbox.length - 1; i >= 0; i--) if (inbox[i].event === event) inbox.splice(i, 1); },
      close() { ws.close(); },
    }));
  });
}

test('rejects a socket with a bad token', async () => {
  await assert.rejects(connect({ token: 'nope' }), /401/);
});

test('REST: register, me, validation, wrong password', async () => {
  const u = await register('rest');
  const me = await api('/api/auth/me', { token: u.token });
  assert.equal(me.status, 200);
  assert.equal(me.body.user.username, u.username);
  assert.equal((await api('/api/auth/me')).status, 401);
  const bad = await api('/api/auth/register', { method: 'POST', body: { email: 'x', username: 'a', password: '1' } });
  assert.equal(bad.status, 400);
  const dup = await api('/api/auth/register', { method: 'POST', body: { email: u.email, username: 'other_' + crypto.randomBytes(2).toString('hex'), password: 'password123' } });
  assert.equal(dup.status, 409);
  const wrong = await api('/api/auth/login', { method: 'POST', body: { email: u.email, password: 'wrong-password' } });
  assert.equal(wrong.status, 401);
  const cats = await api('/api/categories');
  assert.ok(cats.body.categories.length > 0);
});

test('full game: two players, early close when everyone answers, results saved', async () => {
  const alice = await register('alice');
  const bob = await register('bob');
  const a = await connect(alice);
  const b = await connect(bob);
  await a.send('hello');
  await b.send('hello');

  const created = await a.send('game:create', { count: 3, hostPlays: true });
  assert.equal(created.ok, true, created.error);
  const code = created.code;
  assert.match(code, /^[A-Z2-9]{6}$/);

  assert.equal((await b.send('room:join', { code: 'ZZZZZZ' })).ok, false);
  const joined = await b.send('room:join', { code: code.toLowerCase() });
  assert.equal(joined.ok, true, joined.error);
  assert.equal(joined.snapshot.players.length, 2);

  assert.equal((await b.send('game:start')).ok, false, 'only the host can start');
  assert.equal((await a.send('game:start')).ok, true);

  for (let i = 0; i < 3; i++) {
    const qa = await a.next('question:show');
    const qb = await b.next('question:show');
    assert.equal(qa.index, i);
    assert.equal(qb.text, qa.text);
    assert.equal(qa.correctIndex, undefined, 'answer must not leak before the reveal');
    const [ra, rb] = await Promise.all([a.send('answer:submit', { choice: 0 }), b.send('answer:submit', { choice: 1 })]);
    assert.equal(ra.ok, true, ra.error);
    assert.equal(rb.ok, true, rb.error);
    assert.equal((await a.send('answer:submit', { choice: 2 })).ok, false, 'double answer rejected');
    const result = await a.next('question:result', 5000); // closes early: no waiting for the timer
    await b.next('question:result');
    assert.equal(result.index, i);
    assert.equal(typeof result.correctIndex, 'number');
    assert.equal(result.choices.length, 2);
  }

  const endA = await a.next('game:end', 10000);
  assert.equal(endA.leaderboard.length, 2);
  const hist = await api('/api/me/history', { token: alice.token });
  assert.equal(hist.body.games[0].code, code);
  assert.equal(hist.body.totals.gamesPlayed, 1);
  const lb = await api('/api/leaderboard?period=week');
  assert.equal(lb.status, 200);

  // After the game you can host a new one (currentGame was cleared).
  const again = await a.send('game:create', { count: 1 });
  assert.equal(again.ok, true, again.error);
  assert.equal((await a.send('game:cancel')).ok, true);
  a.close();
  b.close();
});

test('timer closes a question nobody answered, reconnect restores the game', { timeout: 90000 }, async () => {
  const host = await register('host');
  const p = await register('p');
  const h = await connect(host);
  let c = await connect(p);
  const { code } = await h.send('game:create', { count: 1, hostPlays: false });
  assert.equal((await c.send('room:join', { code })).ok, true);
  assert.equal((await h.send('game:start')).ok, true);
  const q = await c.next('question:show');

  // Player's tab reloads mid-question: new socket, hello -> room:rejoined with the open question.
  c.close();
  await new Promise((r) => setTimeout(r, 300));
  c = await connect(p);
  assert.equal((await c.send('hello')).inGame, true);
  const snap = await c.next('room:rejoined');
  assert.equal(snap.status, 'question');
  assert.equal(snap.question.index, q.index);
  assert.equal(snap.answered, false);

  // Nobody answers: the GameTimer Lambda must close the question at the deadline.
  const result = await h.next('question:result', q.timeLimit * 1000 + 10000);
  assert.equal(result.choices[0].choice, null);
  const end = await h.next('game:end', 15000);
  assert.equal(end.leaderboard[0].score, 0);
  h.close();
  c.close();
});

test('8 players answering at the same moment: no lost answers', { timeout: 60000 }, async () => {
  const host = await register('crowd');
  const h = await connect(host);
  const { code } = await h.send('game:create', { count: 1, hostPlays: false });
  const clients = [];
  for (let i = 0; i < 8; i++) {
    const c = await connect(await register(`pl${i}`));
    assert.equal((await c.send('room:join', { code })).ok, true);
    clients.push(c);
  }
  await h.send('game:start');
  await Promise.all(clients.map((c) => c.next('question:show')));
  const acks = await Promise.all(clients.map((c, i) => c.send('answer:submit', { choice: i % 4 })));
  for (const a of acks) assert.equal(a.ok, true, a.error);
  const result = await h.next('question:result', 5000);
  assert.equal(result.choices.filter((x) => x.choice !== null).length, 8);
  for (const c of clients) c.close();
  h.close();
});

test('host can pick several categories at once', async () => {
  const host = await register('multi');
  const h = await connect(host);
  await h.send('hello');
  const { categories } = (await api('/api/categories')).body;
  const picked = categories.slice(0, 2);
  const pool = picked.reduce((n, c) => n + c.count, 0);

  const bad = await h.send('game:create', { categories: ['No Such Category'], count: 5 });
  assert.equal(bad.ok, false);

  const created = await h.send('game:create', { categories: picked.map((c) => c.category), count: 30 });
  assert.equal(created.ok, true, created.error);
  assert.equal(created.snapshot.total, Math.min(30, pool), 'questions only come from the picked categories');
  assert.equal(created.snapshot.category, picked.map((c) => c.category).join(', '));
  assert.equal((await h.send('game:cancel')).ok, true);
  h.close();
});

test('admin: stats, question CRUD, ban kicks a live socket', async () => {
  const login = await api('/api/auth/login', { method: 'POST', body: ADMIN });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  const token = login.body.token;
  const victim = await register('victim');
  assert.equal((await api('/api/admin/stats', { token: victim.token })).status, 403);

  const stats = await api('/api/admin/stats', { token });
  assert.equal(stats.status, 200);
  assert.ok(stats.body.totals.questions > 0);

  const created = await api('/api/admin/questions', { method: 'POST', token, body: { text: 'Test question?', options: ['a', 'b'], correctIndex: 1, category: 'Test', timeLimit: 10 } });
  assert.equal(created.status, 201);
  const id = created.body.question.id;
  const updated = await api(`/api/admin/questions/${id}`, { method: 'PUT', token, body: { text: 'Edited?', options: ['a', 'b', 'c'], correctIndex: 2, category: 'Test', timeLimit: 10 } });
  assert.equal(updated.body.question.text, 'Edited?');
  assert.equal((await api(`/api/admin/questions/${id}`, { method: 'DELETE', token })).status, 200);
  assert.equal((await api(`/api/admin/questions/${id}`, { method: 'DELETE', token })).status, 404);

  const v = await connect(victim);
  const closed = new Promise((r) => v.ws.on('close', r));
  const ban = await api(`/api/admin/users/${victim.id}`, { method: 'PATCH', token, body: { banned: true } });
  assert.equal(ban.status, 200);
  await closed;
  assert.equal((await api('/api/auth/me', { token: victim.token })).status, 401);
});
