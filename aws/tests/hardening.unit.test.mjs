// Unit tests for input hardening: JWT algorithm pinning, password limits, OpenTDB import, WebSocket action lookup.
// No AWS or dev server needed:  node --test aws/tests/hardening.unit.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.JWT_SECRET ||= 'x'.repeat(48);

const { signToken, verifyToken } = await import('../backend/src/lib/auth.js');
const { registerSchema } = await import('../backend/src/lib/schemas.js');
const { fetchTriviaQuestions } = await import('../backend/src/lib/trivia.js');
const { handler: wsMessage } = await import('../backend/src/handlers/wsMessage.js');

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

// ---------- JWT ----------
test('tokens round-trip and unsigned ("alg: none") tokens are rejected', () => {
  assert.equal(verifyToken(signToken('user-1'))?.userId, 'user-1');
  const forged = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: 'user-1', iat: Math.floor(Date.now() / 1000) })}.`;
  assert.equal(verifyToken(forged), null);
});

// ---------- passwords ----------
const reg = (password) => registerSchema.safeParse({ email: 'a@b.co', username: 'alice', password }).success;

test('sign-up passwords must fit in bcrypt\'s 72 bytes', () => {
  assert.equal(reg('a'.repeat(72)), true);
  assert.equal(reg('a'.repeat(73)), false);
  assert.equal(reg('é'.repeat(40)), false); // 40 characters but 80 bytes
});

// ---------- OpenTDB import ----------
async function withFetch(results, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /encode=url3986/);
    return new Response(JSON.stringify({ response_code: 0, results }));
  };
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

const enc = encodeURIComponent;

test('imported questions are decoded exactly once and keep the right answer', async () => {
  const qs = await withFetch([{
    category: enc('Science: Computers'),
    question: enc('Which tag is "&lt;b&gt;"?'), // literal text, must not become <b>
    correct_answer: enc('Bold'),
    incorrect_answers: ['Italic', 'Break', 'Underline'].map(enc),
  }], () => fetchTriviaQuestions({ amount: 1 }));
  assert.equal(qs.length, 1);
  assert.equal(qs[0].text, 'Which tag is "&lt;b&gt;"?');
  assert.equal(qs[0].options[qs[0].correctIndex], 'Bold');
  assert.equal(qs[0].options.length, 4);
  assert.equal(qs[0].category, 'Technology');
});

test('imported questions that break the question rules are skipped', async () => {
  const qs = await withFetch([
    { category: enc('History'), question: enc('x'.repeat(400)), correct_answer: 'a', incorrect_answers: ['b', 'c', 'd'] },
    { category: enc('History'), question: enc('Fine?'), correct_answer: 'yes', incorrect_answers: ['no', 'maybe', 'never'] },
  ], () => fetchTriviaQuestions({ amount: 2 }));
  assert.deepEqual(qs.map((q) => q.text), ['Fine?']);
});

// ---------- WebSocket action lookup ----------
test('Object.prototype names are not WebSocket actions', async () => {
  const sent = [];
  globalThis.__QUIBBLE_LOCAL__ = { send: async (_id, data) => sent.push(JSON.parse(data)) };
  try {
    for (const event of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      sent.length = 0;
      const res = await wsMessage({ requestContext: { connectionId: 'c1' }, body: JSON.stringify({ id: 1, event }) });
      assert.equal(res.statusCode, 200);
      assert.deepEqual(sent, [{ type: 'ack', id: 1, ok: false, error: 'Unknown action.' }]);
    }
  } finally {
    delete globalThis.__QUIBBLE_LOCAL__;
  }
});
