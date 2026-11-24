// Unit tests for the abandoned-game sweep's rules (lib/game.js abandonReason, lib/connections.js lastActiveAt).
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.JWT_SECRET ??= 'unit-test-secret-0123456789abcdef0123456789abcdef';
const { abandonReason } = await import('../backend/src/lib/game.js');
const { lastActiveAt, SOCKET_STALE_MS, MSG_WINDOW_MS } = await import('../backend/src/lib/connections.js');

const MIN = 60_000;
const now = Date.parse('2026-11-24T12:00:00Z');
const created = (minsAgo) => new Date(now - minsAgo * MIN).toISOString();
const lobby = (extra = {}) => ({ code: 'ABC234', status: 'lobby', createdAt: created(20), lobbyExpiresAt: now + 60 * MIN, ...extra });
const playing = (extra = {}) => ({ code: 'ABC234', status: 'question', qIndex: 2, createdAt: created(20), ...extra });
const here = { anyoneHere: true, lastSeenAt: now, stuck: null, overdueBy: 0 };
const gone = (minsAgo) => ({ anyoneHere: false, lastSeenAt: now - minsAgo * MIN, stuck: null, overdueBy: 0 });

test('a game someone is still in is left alone', () => {
  assert.equal(abandonReason(lobby(), here, now), null);
  assert.equal(abandonReason(playing(), here, now), null);
  assert.equal(abandonReason(playing({ status: 'reveal' }), here, now), null);
});

test('an empty lobby closes after 10 minutes, an empty game in play after 3', () => {
  assert.equal(abandonReason(lobby(), gone(9), now), null);
  assert.match(abandonReason(lobby(), gone(10), now), /Everyone left the lobby/);
  assert.equal(abandonReason(playing(), gone(2), now), null);
  assert.match(abandonReason(playing(), gone(3), now), /Everyone left/);
  assert.match(abandonReason(playing({ status: 'reveal' }), gone(600), now), /Everyone left/); // the overnight case
});

test('expired lobbies, frozen phases and very old games close even with someone connected', () => {
  assert.match(abandonReason(lobby({ lobbyExpiresAt: now - 1 }), here, now), /lobby expired/);
  assert.equal(abandonReason(playing(), { ...here, stuck: 'reveal', overdueBy: 1 * MIN }, now), null, 'un-stick it first');
  assert.match(abandonReason(playing(), { ...here, stuck: 'reveal', overdueBy: 3 * MIN }, now), /stopped responding/);
  assert.match(abandonReason(playing({ createdAt: created(5 * 60) }), here, now), /ran too long/);
});

test('a socket counts as alive only if it showed life within the last 11 minutes', () => {
  const connectedAt = new Date(now - 30 * MIN).toISOString();
  assert.equal(lastActiveAt({ connectedAt }), now - 30 * MIN);
  const pinged = { connectedAt, rlWin: Math.floor((now - 4 * MIN) / MSG_WINDOW_MS) };
  assert.ok(now - lastActiveAt(pinged) < SOCKET_STALE_MS);
  const stale = { connectedAt, rlWin: Math.floor((now - 12 * MIN) / MSG_WINDOW_MS) };
  assert.ok(now - lastActiveAt(stale) >= SOCKET_STALE_MS);
  assert.equal(lastActiveAt(null), 0);
});
