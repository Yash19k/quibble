// Unit tests for site analytics (lib/analytics.js): heartbeat validation, User-Agent parsing, session items, the online
// window and time buckets in the viewer's time zone. No AWS or dev server needed:
//   node --test aws/tests/analytics.unit.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseBeat, parseAgent, sessionRow, isOnline, floorTo, sidStart, slotOf, sessionPk, ONLINE_MS, SLOT_MS,
} from '../backend/src/lib/analytics.js';

const NOW = Date.parse('2026-11-22T10:00:00Z');
const sid = (t = NOW) => `${t.toString(36).padStart(8, '0')}0123456789abcdef`;
const vid = 'a'.repeat(24);

test('a valid heartbeat is accepted and cleaned up', () => {
  const b = parseBeat({ sid: sid(), vid, page: 'game', game: 'ABC123', dt: 999, ref: 'https://www.Google.com/search?q=x', leave: true }, NOW);
  assert.equal(b.start, NOW);
  assert.equal(b.dt, 40, 'one beat cannot claim more than 40 s');
  assert.equal(b.game, 'ABC123');
  assert.equal(b.ref, 'google.com', 'host only, no path or query');
  assert.equal(b.leave, true);
  assert.equal(parseBeat({ sid: sid(), vid, page: 'home', game: 'ABC123', dt: -5 }, NOW).game, null, 'a game code only on the game page');
  assert.equal(parseBeat({ sid: sid(), vid, page: 'home', dt: -5 }, NOW).dt, 0);
  assert.equal(parseBeat({ sid: sid(), vid, page: 'home', ref: 'javascript:alert(1)' }, NOW).ref, null);
});

test('anything that is not one of our heartbeats is a 400', () => {
  const bad = [
    {}, { sid: 'x', vid, page: 'home' }, { sid: sid(), vid: 'nothex', page: 'home' }, { sid: sid(), vid, page: 'secret' },
    { sid: sid(NOW - 27 * 3_600_000), vid, page: 'home' }, // older than any real session: can't write old partitions
    { sid: sid(NOW + 3_600_000), vid, page: 'home' },
  ];
  for (const body of bad) assert.throws(() => parseBeat(body, NOW), (e) => e.status === 400, JSON.stringify(body));
});

test('User-Agent parsing: device, browser, OS and bots', () => {
  const iphone = parseAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1');
  assert.deepEqual(iphone, { bot: false, device: 'mobile', browser: 'Safari', os: 'iOS' });
  const edge = parseAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 Edg/140.0');
  assert.deepEqual(edge, { bot: false, device: 'desktop', browser: 'Edge', os: 'Windows' });
  const tab = parseAgent('Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36');
  assert.equal(tab.device, 'tablet', 'Android without "Mobile" is a tablet');
  assert.equal(parseAgent('Googlebot/2.1 (+http://www.google.com/bot.html)').bot, true);
  assert.equal(parseAgent('node').bot, true, 'scripts (the load test) are not visitors');
  assert.equal(parseAgent('').bot, true);
});

test('session items: slots, sets and the online window', () => {
  const n = slotOf(NOW);
  const row = sessionRow({
    pk: sessionPk(NOW), sk: sid(), vid, uid: 'u1', un: 'ada', page: 'play', pages: new Set(['play', 'home']), games: new Set(['ABC123']),
    start: NOW - 60_000, last: NOW, act: 55, [`s${n}`]: 30, [`s${n - 1}`]: 25, sk2: 'not a slot',
  });
  assert.deepEqual([...row.slots], [[n, 30], [n - 1, 25]]);
  assert.deepEqual(row.pages, ['home', 'play']);
  assert.equal(row.username, 'ada');
  assert.equal(sessionPk(NOW), 'SESS#2026-11-22');
  assert.equal(n * SLOT_MS <= NOW && NOW < (n + 1) * SLOT_MS, true);
  assert.equal(sidStart(sid()), NOW);
  assert.equal(isOnline(row, NOW + ONLINE_MS), true);
  assert.equal(isOnline(row, NOW + ONLINE_MS + 1), false, 'missed beats: offline');
  assert.equal(isOnline({ ...row, left: NOW }, NOW + 1000), false, 'said goodbye: offline at once');
});

test('buckets follow the viewer time zone, half-hour offsets included', () => {
  const t = Date.parse('2026-11-22T10:47:00Z'); // 16:17 in India (UTC+5:30)
  assert.equal(new Date(floorTo(t, 'hour', 330)).toISOString(), '2026-11-22T10:30:00.000Z', '16:00 IST');
  assert.equal(new Date(floorTo(t, 'day', 330)).toISOString(), '2026-11-21T18:30:00.000Z', 'midnight IST');
  assert.equal(new Date(floorTo(t, 'hour', 0)).toISOString(), '2026-11-22T10:00:00.000Z');
  assert.equal(new Date(floorTo(t, 'day', -300)).toISOString(), '2026-11-22T05:00:00.000Z', 'midnight in New York');
});
