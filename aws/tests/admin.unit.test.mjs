// Unit tests for the admin console's pure helpers: session versions in tokens ("sign out everywhere"), calendar days in
// the viewer's time zone, game states, and the chart's axis scale. No AWS or dev server needed:
//   node --test aws/tests/admin.unit.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { signToken, verifyToken } from '../backend/src/lib/auth.js';
import { tokenRevoked } from '../backend/src/lib/users.js';
import { dayOf, lastDays, gameState, gameRow } from '../backend/src/lib/admin.js';
import { niceScale, plural, duration, bytes } from '../../public/js/admin/ui.js';

process.env.JWT_SECRET ||= 'unit-test-secret-0123456789abcdef0123456789abcdef';

test('tokens carry the session version; a sign-out everywhere (version bump) ends exactly the older ones', () => {
  const old = verifyToken(signToken('u1'));
  assert.equal(old.userId, 'u1');
  assert.equal(old.sv, 0, 'tokens from before session versions count as version 0');
  assert.equal(tokenRevoked({ id: 'u1' }, old.sv), false);
  assert.equal(tokenRevoked({ id: 'u1', sessionVersion: 1 }, old.sv), true, 'signed out: the old token is dead');
  const fresh = verifyToken(signToken('u1', 1));
  assert.equal(fresh.sv, 1);
  assert.equal(tokenRevoked({ id: 'u1', sessionVersion: 1 }, fresh.sv), false, 'a login after the sign-out works at once');
  assert.equal(tokenRevoked({ id: 'u1', sessionVersion: 2 }, fresh.sv), true);
  assert.equal(tokenRevoked({ id: 'u1' }, undefined), false, 'sockets saved before session versions');
});

test('days are the viewer’s calendar days', () => {
  const iso = '2026-11-20T20:00:00.000Z';
  assert.equal(dayOf(iso, 0), '2026-11-20');
  assert.equal(dayOf(iso, 330), '2026-11-21', 'already the next day in India');
  assert.equal(dayOf(iso, -300), '2026-11-20');
  assert.equal(dayOf(undefined), null);
  const now = Date.parse('2026-11-21T02:00:00.000Z');
  assert.deepEqual(lastDays(3, 0, now), ['2026-11-19', '2026-11-20', '2026-11-21']);
  assert.deepEqual(lastDays(2, -300, now), ['2026-11-19', '2026-11-20'], 'still the 20th in New York');
  const month = lastDays(30, 330, now);
  assert.equal(month.length, 30);
  assert.equal(new Set(month).size, 30);
});

test('game states: an unstarted lobby past its expiry is expired', () => {
  const now = Date.parse('2026-11-21T10:00:00.000Z');
  assert.equal(gameState({ status: 'lobby', lobbyExpiresAt: now + 1000 }, now), 'lobby');
  assert.equal(gameState({ status: 'lobby', lobbyExpiresAt: now - 1000 }, now), 'expired');
  assert.equal(gameState({ status: 'question' }, now), 'question');
  assert.equal(gameState({ status: 'cancelled' }, now), 'cancelled');
  const row = gameRow({ code: 'ABC234', status: 'question', qIndex: 2, total: 10, playerCount: 7, lobbyExpiresAt: 0 }, now);
  assert.equal(row.live, true);
  assert.equal(row.state, 'question');
  assert.equal(row.hostName, null);
  assert.equal(gameRow({ code: 'ABC234', status: 'lobby', lobbyExpiresAt: now - 1 }, now).live, false);
});

test('chart scale: round gridlines that cover the maximum', () => {
  assert.deepEqual(niceScale(0), { top: 4, step: 1 });
  assert.deepEqual(niceScale(3), { top: 3, step: 1 });
  assert.deepEqual(niceScale(9), { top: 10, step: 5 });
  assert.deepEqual(niceScale(17), { top: 20, step: 5 });
  assert.deepEqual(niceScale(230), { top: 300, step: 100 });
  for (const max of [1, 7, 42, 99, 101, 999, 12345]) {
    const { top, step } = niceScale(max);
    assert.ok(top >= max && Number.isInteger(step) && step >= 1 && Number.isInteger(top / step), `max ${max}: top ${top}, step ${step}`);
    assert.ok(top / step <= 5, `max ${max}: at most 5 gridlines`);
  }
});

test('formatting helpers', () => {
  assert.equal(plural(1, 'game'), '1 game');
  assert.equal(plural(3, 'quiz', 'quizzes'), '3 quizzes');
  assert.equal(duration(42_000), '42 s');
  assert.equal(duration(252_000), '4 min 12 s');
  assert.equal(bytes(512), '512 B');
  assert.equal(bytes(1536), '1.5 KB');
});
