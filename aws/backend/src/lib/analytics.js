// Site analytics: who is on the site right now, and how it has been used over time.
//
// Every page (landing, play, how-it-works, admin) runs public/js/presence.js, which POSTs /api/presence about every
// 30 s while the tab is visible, plus once when it is hidden or closed ("leave"). Each visit (a "session": the same
// browser, with no gap longer than 30 minutes) is one item in AdminTable:
//
//   pk "SESS#<UTC day the session started>"   sk "<session id>"
//   vid       anonymous browser id (localStorage), so a returning visitor counts once
//   uid/un    the signed-in account and its username at the time (absent for guests)
//   page      the page it is on now (home | play | game | how | admin), game = the game code while in one
//   pages     every page it visited (string set), games = every game code it was in
//   dev/br/os device class, browser and OS from the User-Agent; ref = the referring site, first beat only
//   start, last, left   first beat, latest beat, and when it said goodbye (ms since epoch)
//   act       seconds the tab was visible, beats = heartbeats received
//   s<n>      seconds visible inside 5-minute slot n (n = floor(ms / 300000)). This is what the hourly charts, the
//             concurrency timeline and the heatmap are built from.
//
// No IP address is stored. Items expire after KEEP_DAYS, long enough for a 90-day range plus the 90 days before it.
//
// Reads Query one partition per day. That is cheap at this app's size (hundreds to a few thousand sessions a day);
// at a much larger scale you would roll the slots up into hourly counters instead.
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, queryAll } from './db.js';
import { env } from './config.js';
import { verifyToken } from './auth.js';
import { getUserById } from './users.js';
import { HttpError } from './errors.js';

export const BEAT_MS = 30_000;
export const ONLINE_MS = 75_000; // two missed beats and a bit: the tab was closed, hidden or lost its network
export const SLOT_MS = 300_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const KEEP_DAYS = 200;
const MAX_SESSION_MS = 26 * HOUR_MS; // presence.js starts a new session after 12 h; anything older is not ours
const MAX_DT = 40; // seconds of visible time one beat may claim (beats are 30 s apart)
const MIN_GAP_MS = 8_000; // per container: a second beat this soon from the same session is ignored

export const PAGES = ['home', 'play', 'game', 'how', 'admin'];
const SID_RE = /^[0-9a-z]{8}[0-9a-f]{16}$/;
const VID_RE = /^[0-9a-f]{24}$/;
const GAME_RE = /^[A-Z0-9]{6}$/;

export const sessionPk = (ms) => `SESS#${new Date(ms).toISOString().slice(0, 10)}`;
export const slotOf = (ms) => Math.floor(ms / SLOT_MS);
/** A session id starts with its creation time in base 36 (8 characters), then 16 random hex characters. */
export const sidStart = (sid) => parseInt(sid.slice(0, 8), 36);

// ---------- recording ----------
/** Device class, browser and OS from a User-Agent string; `bot` for crawlers and scripts (not recorded). */
export function parseAgent(ua = '') {
  const s = String(ua);
  const bot = !s || /bot|crawl|spider|slurp|headless|lighthouse|preview|curl|wget|python|node|undici|axios|go-http/i.test(s);
  const device = /iPad|Tablet|PlayBook|Silk|Android(?!.*Mobile)/i.test(s) ? 'tablet'
    : /Mobi|iPhone|iPod|Android|Windows Phone/i.test(s) ? 'mobile' : 'desktop';
  const browser = /Edg(e|A|iOS)?\//.test(s) ? 'Edge'
    : /OPR\/|Opera/.test(s) ? 'Opera'
      : /SamsungBrowser/.test(s) ? 'Samsung Internet'
        : /Firefox\/|FxiOS/.test(s) ? 'Firefox'
          : /Chrome\/|CriOS/.test(s) ? 'Chrome'
            : /Safari\//.test(s) ? 'Safari' : 'Other';
  const os = /Windows/.test(s) ? 'Windows'
    : /iPhone|iPad|iPod/.test(s) ? 'iOS'
      : /Android/.test(s) ? 'Android'
        : /CrOS/.test(s) ? 'ChromeOS'
          : /Mac OS X|Macintosh/.test(s) ? 'macOS'
            : /Linux/.test(s) ? 'Linux' : 'Other';
  return { bot, device, browser, os };
}

/** Validates a heartbeat body. Throws 400 for anything that isn't one of ours. */
export function parseBeat(body, now = Date.now()) {
  const b = body && typeof body === 'object' ? body : {};
  const sid = typeof b.sid === 'string' && SID_RE.test(b.sid) ? b.sid : null;
  const vid = typeof b.vid === 'string' && VID_RE.test(b.vid) ? b.vid : null;
  if (!sid || !vid) throw new HttpError(400, 'Invalid session');
  const start = sidStart(sid);
  if (!(start > now - MAX_SESSION_MS && start < now + 5 * 60_000)) throw new HttpError(400, 'Session expired');
  const page = PAGES.includes(b.page) ? b.page : null;
  if (!page) throw new HttpError(400, 'Invalid page');
  const game = page === 'game' && typeof b.game === 'string' && GAME_RE.test(b.game) ? b.game : null;
  const dt = Math.min(Math.max(Math.round(Number(b.dt) || 0), 0), MAX_DT);
  let ref = null;
  if (typeof b.ref === 'string' && b.ref.length <= 500) {
    try {
      const u = new URL(b.ref);
      if (u.protocol === 'https:' || u.protocol === 'http:') ref = u.hostname.toLowerCase().replace(/^www\./, '').slice(0, 100) || null;
    } catch { /* not a URL */ }
  }
  return { sid, vid, start, page, game, dt, leave: b.leave === true, ref };
}

const lastBeat = new Map(); // sid -> ms, this container only
const people = new Map(); // userId -> { username, role, at }

async function whoIs(userId, now) {
  const hit = people.get(userId);
  if (hit && now - hit.at < 5 * 60_000) return hit.username ? hit : null;
  const user = await getUserById(userId).catch(() => null);
  const entry = { username: user && !user.banned ? user.username : null, role: user?.role ?? null, at: now };
  if (people.size > 5000) people.clear();
  people.set(userId, entry);
  return entry.username ? entry : null;
}

/** Records one heartbeat. `token` (optional) names the signed-in account; guests stay anonymous. */
export async function recordBeat(beat, { token = null, userAgent = '', now = Date.now() } = {}) {
  const agent = parseAgent(userAgent);
  if (agent.bot) return { ok: true, recorded: false };
  const prev = lastBeat.get(beat.sid);
  if (!beat.leave && prev && now - prev < MIN_GAP_MS) return { ok: true, recorded: false };
  if (lastBeat.size > 20_000) lastBeat.clear();
  lastBeat.set(beat.sid, now);

  const claims = verifyToken(token);
  const who = claims ? await whoIs(claims.userId, now) : null;

  const names = {
    '#last': 'last', '#page': 'page', '#exp': 'expiresAt', '#start': 'start', '#vid': 'vid', '#dev': 'dev', '#br': 'br',
    '#os': 'os', '#act': 'act', '#beats': 'beats', '#pages': 'pages', '#slot': `s${slotOf(now)}`, '#left': 'left',
  };
  const values = {
    ':now': now, ':page': beat.page, ':exp': Math.floor(now / 1000) + KEEP_DAYS * 86_400, ':vid': beat.vid,
    ':dev': agent.device, ':br': agent.browser, ':os': agent.os, ':dt': beat.dt, ':one': 1, ':pset': new Set([beat.page]),
  };
  const set = ['#last = :now', '#page = :page', '#exp = :exp', '#start = if_not_exists(#start, :now)',
    '#vid = if_not_exists(#vid, :vid)', '#dev = if_not_exists(#dev, :dev)', '#br = if_not_exists(#br, :br)',
    '#os = if_not_exists(#os, :os)'];
  const remove = [];
  const add = ['#act :dt', '#beats :one', '#pages :pset', '#slot :dt'];
  if (beat.ref) {
    names['#ref'] = 'ref';
    values[':ref'] = beat.ref;
    set.push('#ref = if_not_exists(#ref, :ref)');
  }
  if (who) {
    Object.assign(names, { '#uid': 'uid', '#un': 'un', '#role': 'role' });
    Object.assign(values, { ':uid': claims.userId, ':un': who.username, ':role': who.role });
    set.push('#uid = :uid', '#un = :un', '#role = :role');
  }
  names['#game'] = 'game';
  if (beat.game) {
    names['#games'] = 'games';
    values[':game'] = beat.game;
    values[':gset'] = new Set([beat.game]);
    set.push('#game = :game');
    add.push('#games :gset');
  } else remove.push('#game');
  if (beat.leave) set.push('#left = :now');
  else remove.push('#left');

  await ddb.send(new UpdateCommand({
    TableName: env.adminTable,
    Key: { pk: sessionPk(beat.start), sk: beat.sid },
    UpdateExpression: `SET ${set.join(', ')}${remove.length ? ` REMOVE ${remove.join(', ')}` : ''} ADD ${add.join(', ')}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  }));
  return { ok: true, recorded: true };
}

// ---------- reading ----------
/** An item as the admin pages see it. */
export function sessionRow(it) {
  const slots = new Map();
  for (const [k, v] of Object.entries(it)) {
    if (k.length > 1 && k[0] === 's' && /^s\d+$/.test(k)) slots.set(Number(k.slice(1)), Number(v) || 0);
  }
  return {
    sid: it.sk,
    vid: it.vid ?? it.sk,
    userId: it.uid ?? null,
    username: it.un ?? null,
    role: it.role ?? null,
    page: it.page ?? null,
    game: it.game ?? null,
    pages: [...(it.pages ?? [])].sort(),
    games: [...(it.games ?? [])].sort(),
    device: it.dev ?? 'desktop',
    browser: it.br ?? 'Other',
    os: it.os ?? 'Other',
    ref: it.ref ?? null,
    start: Number(it.start) || 0,
    last: Number(it.last) || 0,
    left: it.left ? Number(it.left) : null,
    active: Number(it.act) || 0,
    beats: Number(it.beats) || 0,
    slots,
  };
}

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Every session that started on the UTC days from `fromMs` to `toMs`. */
async function sessionsBetween(fromMs, toMs) {
  const days = [];
  for (let t = Date.parse(`${isoDay(fromMs)}T00:00:00Z`); t <= toMs; t += DAY_MS) days.push(isoDay(t));
  const out = [];
  for (let i = 0; i < days.length; i += 10) {
    const batch = await Promise.all(days.slice(i, i + 10).map((d) => queryAll({
      TableName: env.adminTable,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': `SESS#${d}` },
    })));
    for (const items of batch) for (const it of items) out.push(sessionRow(it));
  }
  return out;
}

export const isOnline = (s, now = Date.now()) => !s.left && now - s.last <= ONLINE_MS;

const publicSession = (s, now) => ({
  sid: s.sid,
  userId: s.userId,
  username: s.username,
  role: s.role,
  page: s.page,
  game: s.game,
  pages: s.pages,
  games: s.games,
  device: s.device,
  browser: s.browser,
  os: s.os,
  ref: s.ref,
  startedAt: s.start,
  lastSeen: s.last,
  active: s.active,
  online: isOnline(s, now),
});

const countBy = (items, key) => {
  const m = new Map();
  for (const it of items) {
    const k = key(it);
    if (k != null) m.set(k, (m.get(k) || 0) + 1);
  }
  return [...m].map(([k, count]) => ({ key: k, count })).sort((a, b) => b.count - a.count || String(a.key).localeCompare(String(b.key)));
};

/** Who is on the site right now, and the last two hours in 5-minute steps. */
export async function live({ now = Date.now() } = {}) {
  const sessions = await sessionsBetween(now - MAX_SESSION_MS, now);
  const online = sessions.filter((s) => isOnline(s, now));
  // A signed-in person counts once however many devices they use; a guest is one browser.
  const person = (s) => (s.userId ? `u:${s.userId}` : `v:${s.vid}`);
  const nowSlot = slotOf(now);
  const recent = [];
  for (let n = nowSlot - 23; n <= nowSlot; n++) {
    const who = new Set();
    for (const s of sessions) if (s.slots.has(n)) who.add(person(s));
    recent.push({ t: n * SLOT_MS, value: who.size });
  }
  return {
    generatedAt: now,
    onlineWindowSec: ONLINE_MS / 1000,
    beatSec: BEAT_MS / 1000,
    counts: {
      total: new Set(online.map(person)).size,
      signedIn: new Set(online.filter((s) => s.userId).map((s) => s.userId)).size,
      guests: new Set(online.filter((s) => !s.userId).map((s) => s.vid)).size,
      sessions: online.length,
    },
    byPage: countBy(online, (s) => s.page).map(({ key, count }) => ({ page: key, count })),
    byDevice: countBy(online, (s) => s.device).map(({ key, count }) => ({ device: key, count })),
    online: online
      .sort((a, b) => (!!b.userId - !!a.userId) || a.start - b.start)
      .map((s) => publicSession(s, now)),
    recent,
  };
}

// ---------- the report ----------
export const RANGES = {
  '24h': { count: 24, unit: 'hour' },
  '7d': { count: 7 * 24, unit: 'hour' },
  '30d': { count: 30, unit: 'day' },
  '90d': { count: 90, unit: 'day' },
};

const DURATION_BUCKETS = [
  [0, 10, 'Under 10 s'], [10, 60, '10 s – 1 min'], [60, 300, '1 – 5 min'], [300, 900, '5 – 15 min'],
  [900, 1800, '15 – 30 min'], [1800, Infinity, '30 min +'],
];

/** The start (ms) of the hour or calendar day `ms` falls in, for a viewer `tz` minutes east of UTC. */
export function floorTo(ms, unit, tz = 0) {
  const size = unit === 'hour' ? HOUR_MS : DAY_MS;
  const off = tz * 60_000;
  return Math.floor((ms + off) / size) * size - off;
}

/**
 * Usage over a range ('24h' | '7d' hourly, '30d' | '90d' daily, in the viewer's time zone) and the same length before it.
 * `results` (one row per player per finished game) and `users` come from the caller, which already loads them.
 */
export async function report({ range = '7d', tz = 0, now = Date.now(), results = [], users = [] } = {}) {
  const cfg = RANGES[range] ?? RANGES['7d'];
  const size = cfg.unit === 'hour' ? HOUR_MS : DAY_MS;
  const start = floorTo(now, cfg.unit, tz) - (cfg.count - 1) * size;
  const end = now;
  const prevStart = start - cfg.count * size;
  const sessions = await sessionsBetween(prevStart - MAX_SESSION_MS, now);
  const off = tz * 60_000;
  const bucketOf = (ms) => Math.floor((ms - start) / size);
  const person = (s) => (s.userId ? `u:${s.userId}` : `v:${s.vid}`);

  const buckets = Array.from({ length: cfg.count }, (_, i) => ({
    t: start + i * size, visitors: new Set(), sessions: new Set(), users: new Set(), active: 0, peak: 0, peakAt: null,
    games: new Set(), plays: 0, signups: 0,
  }));
  const blank = () => ({ visitors: new Set(), sessions: new Set(), users: new Set(), active: 0, peak: 0, peakAt: null,
    games: new Set(), plays: 0, signups: 0, sessionActive: new Map(), sessionsList: [] });
  const cur = blank();
  const prev = blank();
  const slotPeople = new Map(); // slot -> Set(person), both periods

  for (const s of sessions) {
    let inCur = 0;
    let inPrev = 0;
    for (const [n, sec] of s.slots) {
      const t = n * SLOT_MS;
      if (t >= end || t < prevStart) continue;
      const p = person(s);
      if (!slotPeople.has(n)) slotPeople.set(n, new Set());
      slotPeople.get(n).add(p);
      const period = t >= start ? cur : prev;
      period.visitors.add(p);
      period.sessions.add(s.sid);
      if (s.userId) period.users.add(s.userId);
      period.active += sec;
      if (t >= start) {
        inCur += sec + 1e-9;
        const b = buckets[bucketOf(t)];
        if (b) {
          b.visitors.add(p);
          b.sessions.add(s.sid);
          if (s.userId) b.users.add(s.userId);
          b.active += sec;
        }
      } else inPrev += sec + 1e-9;
    }
    if (inCur) { cur.sessionActive.set(s.sid, Math.round(inCur)); cur.sessionsList.push(s); }
    if (inPrev) { prev.sessionActive.set(s.sid, Math.round(inPrev)); prev.sessionsList.push(s); }
  }

  // Peak concurrency: the busiest 5-minute slot, per bucket and per period.
  const fine = [];
  for (const [n, who] of slotPeople) {
    const t = n * SLOT_MS;
    const period = t >= start ? cur : prev;
    if (who.size > period.peak) { period.peak = who.size; period.peakAt = t; }
    if (t >= start) {
      const b = buckets[bucketOf(t)];
      if (b && who.size > b.peak) { b.peak = who.size; b.peakAt = t; }
    }
  }
  if (range === '24h') {
    for (let n = slotOf(start); n <= slotOf(end); n++) fine.push({ t: n * SLOT_MS, value: slotPeople.get(n)?.size ?? 0 });
  }

  // Heatmap: average people online for each weekday x hour (viewer's time) across the range.
  const heat = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => ({ sum: 0, slots: 0 })));
  for (let n = slotOf(start); n * SLOT_MS < end; n++) {
    const local = new Date(n * SLOT_MS + off);
    const cell = heat[local.getUTCDay()][local.getUTCHours()];
    cell.slots += 1;
    cell.sum += slotPeople.get(n)?.size ?? 0;
  }

  // Games, plays and sign-ups.
  const gameId = (r) => `${r.code}#${r.endedAt}`;
  const playersOf = new Map();
  const catCount = new Map();
  const playsByUser = new Map();
  for (const r of results) {
    const t = Date.parse(r.endedAt);
    if (!Number.isFinite(t) || t < prevStart || t >= end) continue;
    const period = t >= start ? cur : prev;
    period.games.add(gameId(r));
    period.plays += 1;
    if (t >= start) {
      const b = buckets[bucketOf(t)];
      if (b) { b.games.add(gameId(r)); b.plays += 1; }
      playersOf.set(gameId(r), (playersOf.get(gameId(r)) || 0) + 1);
      if (!catCount.has(gameId(r))) catCount.set(gameId(r), r.category || 'All categories');
      playsByUser.set(r.userId, (playsByUser.get(r.userId) || 0) + 1);
    }
  }
  for (const u of users) {
    const t = Date.parse(u.createdAt);
    if (!Number.isFinite(t) || t < prevStart || t >= end) continue;
    if (t >= start) {
      cur.signups += 1;
      const b = buckets[bucketOf(t)];
      if (b) b.signups += 1;
    } else prev.signups += 1;
  }

  const totals = (p) => {
    const n = p.sessionsList.length;
    const bounces = p.sessionsList.filter((s) => (p.sessionActive.get(s.sid) ?? 0) < 15 && s.pages.length <= 1).length;
    return {
      visitors: p.visitors.size,
      sessions: p.sessions.size,
      signedIn: p.users.size,
      activeSec: Math.round(p.active),
      avgSessionSec: n ? Math.round([...p.sessionActive.values()].reduce((a, b) => a + b, 0) / n) : 0,
      bounceRate: n ? bounces / n : null,
      peak: p.peak,
      peakAt: p.peakAt,
      games: p.games.size,
      plays: p.plays,
      signups: p.signups,
    };
  };

  const curList = cur.sessionsList;
  const userById = new Map(users.map((u) => [u.id, u]));
  const byUser = new Map();
  for (const s of curList) {
    if (!s.userId) continue;
    const e = byUser.get(s.userId) ?? { userId: s.userId, username: s.username, sessions: 0, activeSec: 0, lastSeen: 0, devices: new Set() };
    e.sessions += 1;
    e.activeSec += cur.sessionActive.get(s.sid) ?? 0;
    e.lastSeen = Math.max(e.lastSeen, s.last);
    e.devices.add(s.device);
    e.username = userById.get(s.userId)?.username ?? e.username;
    byUser.set(s.userId, e);
  }
  const returning = [...cur.visitors].filter((p) => prev.visitors.has(p)).length;
  const gameSizes = [...playersOf.values()];

  return {
    range,
    unit: cfg.unit,
    tz,
    generatedAt: now,
    start,
    end,
    totals: totals(cur),
    prev: totals(prev),
    returningVisitors: returning,
    newVisitors: cur.visitors.size - returning,
    series: buckets.map((b) => ({
      t: b.t, visitors: b.visitors.size, sessions: b.sessions.size, signedIn: b.users.size,
      activeMin: Math.round(b.active / 60), peak: b.peak, games: b.games.size, plays: b.plays, signups: b.signups,
    })),
    concurrency: range === '24h' ? fine : buckets.map((b) => ({ t: b.t, value: b.peak })),
    concurrencyStep: range === '24h' ? 'slot' : cfg.unit,
    heatmap: heat.map((row) => row.map((c) => (c.slots ? Math.round((c.sum / c.slots) * 100) / 100 : null))),
    pages: PAGES.map((page) => ({ page, count: curList.filter((s) => s.pages.includes(page)).length })).filter((p) => p.count),
    devices: countBy(curList, (s) => s.device).map(({ key, count }) => ({ device: key, count })),
    browsers: countBy(curList, (s) => s.browser).map(({ key, count }) => ({ browser: key, count })),
    os: countBy(curList, (s) => s.os).map(({ key, count }) => ({ os: key, count })),
    referrers: countBy(curList, (s) => s.ref ?? '(direct)').slice(0, 8).map(({ key, count }) => ({ ref: key, count })),
    durations: DURATION_BUCKETS.map(([lo, hi, label]) => ({
      label, count: curList.filter((s) => { const a = cur.sessionActive.get(s.sid) ?? 0; return a >= lo && a < hi; }).length,
    })),
    audience: {
      signedInSessions: curList.filter((s) => s.userId).length,
      guestSessions: curList.filter((s) => !s.userId).length,
    },
    gameStats: {
      avgPlayers: gameSizes.length ? Math.round((gameSizes.reduce((a, b) => a + b, 0) / gameSizes.length) * 10) / 10 : 0,
      biggest: gameSizes.length ? Math.max(...gameSizes) : 0,
      categories: countBy([...catCount.values()], (c) => c).slice(0, 8).map(({ key, count }) => ({ category: key, count })),
    },
    topUsers: [...byUser.values()]
      .sort((a, b) => b.activeSec - a.activeSec)
      .slice(0, 10)
      .map((e) => ({ ...e, devices: [...e.devices], plays: playsByUser.get(e.userId) ?? 0 })),
    sessions: [...curList]
      .sort((a, b) => b.last - a.last)
      .slice(0, 60)
      .map((s) => ({ ...publicSession(s, now), activeInRange: cur.sessionActive.get(s.sid) ?? 0 })),
  };
}
