// Load test against a running Quibble backend (the local emulator by default, or a deployment via --api / --ws):
// N players sign up at once, join ONE game and play it to the end while some answer in the last half second, some
// lose their socket right after answering and everybody reconnects at once (once mid-question, once mid-reveal).
// It drives the real browser modules (public/js/realtime.js and public/js/net.js), so resends, reconnects and
// snapshot recovery run exactly as in a player's browser.
//
//   npm run test:load -- --players 200 --questions 12 --spread 0 --silent 10 --late 20 --drop 15
//
// Exits with 1 when any check fails. Per-partition-key DynamoDB capacity is checked against the local dev server's
// GET /__local/capacity, so start it with LOCAL_TRACK_CAPACITY=1 (or pass --capacity off; a real deployment has no such
// endpoint: watch the CloudWatch throttle alarms instead). Registers players + 1 accounts: repeated runs on one machine
// may need a higher REGISTER_MAX_PER_IP on the server. An answer refused with "Too late!" is a failure when it provably
// reached the server before acceptUntil; a possible deadline miss is excused for the --late cohort, and for on-time
// answers only while the server was visibly throttled (LOCAL_LAMBDA_CONCURRENCY): see verifyRefusals().
import { Realtime } from '../../public/js/realtime.js';
import { request } from '../../public/js/net.js';
import { PROTOCOL, LOAD_CATEGORY, LOAD_TIME_LIMIT, ensureLoadTestQuestions, http, randInt, rankProblems, shuffle, sleep, summarize, tag } from './helpers.mjs';

// Node 22.4+ has a global WebSocket (what realtime.js uses by default); older builds fall back to the `ws` package.
const WebSocketImpl = globalThis.WebSocket ?? (await import('ws')).default;

const HELP = `Usage: npm run test:load -- [flags]
  --players N               players who sign up and join (default 200)
  --questions N             questions in the game, 1-30 (default 12)
  --spread MS               spread the on-time answers over this many ms (default 0 = all at once)
  --silent N                players who never answer (default 10)
  --late N                  players who answer in the last 500 ms before the timer ends (default 20)
  --drop PCT                % of on-time players whose socket drops for 1-5 s right after answering (default 15)
  --reconnect-storm on|off  every socket drops at once during one question and one reveal (default on)
  --capacity on|off         require the per-key capacity check on a local server (default on: needs the dev server
                            started with LOCAL_TRACK_CAPACITY=1)
  --capacity-pct PCT        max share of DynamoDB's per-key 1,000 WCU/s and 3,000 RCU/s (default 30)
  --api URL                 HTTP API (default $LOAD_API or http://localhost:5050)
  --ws URL                  WebSocket API (default $LOAD_WS or ws://localhost:5050/ws)
  --admin-email EMAIL       admin who owns the "Load Test" questions (default $ADMIN_EMAIL or admin@example.com)
  --admin-password PASS     (default $ADMIN_PASSWORD or admin12345)`;

const PASSWORD = 'password123';
const CONNECT_TIMEOUT_MS = 60_000;
const SHOW_TIMEOUT_MS = 40_000; // reveal (4 s) + timer slack + recovery
const END_TIMEOUT_MS = 40_000;
const WATCHDOG_MS = 4000; // like the page: a phase overdue by this much means a lost push -> 'sync'
const PUSHES = ['room:state', 'question:show', 'answer:count', 'question:result', 'game:end', 'game:cancelled'];

// ---------- options ----------
function usage(problem) {
  console.error(`${problem}\n\n${HELP}`);
  process.exit(2);
}

function parseArgs(argv) {
  const o = {
    players: 200, questions: 12, spread: 0, silent: 10, late: 20, drop: 15, reconnectStorm: true, capacity: true, capacityPct: 30,
    api: process.env.LOAD_API || 'http://localhost:5050',
    ws: process.env.LOAD_WS || 'ws://localhost:5050/ws',
    adminEmail: process.env.ADMIN_EMAIL || 'admin@example.com',
    adminPassword: process.env.ADMIN_PASSWORD || 'admin12345',
  };
  const numbers = { players: 'players', questions: 'questions', spread: 'spread', silent: 'silent', late: 'late', drop: 'drop', 'capacity-pct': 'capacityPct' };
  const strings = { api: 'api', ws: 'ws', 'admin-email': 'adminEmail', 'admin-password': 'adminPassword' };
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(argv[i]);
    if (!m) usage(`Unexpected argument "${argv[i]}".`);
    const [, name, inline] = m;
    const value = () => inline ?? (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : undefined);
    if (name === 'help') {
      console.log(HELP);
      process.exit(0);
    } else if (name === 'no-reconnect-storm') {
      o.reconnectStorm = false;
    } else if (name === 'no-capacity') {
      o.capacity = false;
    } else if (name === 'reconnect-storm' || name === 'capacity') {
      const v = (value() ?? 'on').toLowerCase();
      if (!['on', 'off', 'true', 'false', '1', '0', 'yes', 'no'].includes(v)) usage(`--${name} takes on or off.`);
      o[name === 'capacity' ? 'capacity' : 'reconnectStorm'] = ['on', 'true', '1', 'yes'].includes(v);
    } else if (numbers[name]) {
      const v = Number(value());
      if (!Number.isFinite(v) || v < 0) usage(`--${name} needs a number >= 0.`);
      o[numbers[name]] = Math.floor(v);
    } else if (strings[name]) {
      const v = value();
      if (!v) usage(`--${name} needs a value.`);
      o[strings[name]] = v;
    } else {
      usage(`Unknown flag --${name}.`);
    }
  }
  if (o.players < 1) usage('--players must be at least 1.');
  if (o.questions < 1 || o.questions > 30) usage('--questions must be 1-30 (a game has at most 30 questions).');
  if (o.drop > 100 || o.capacityPct > 100) usage('--drop and --capacity-pct are percentages (0-100).');
  if (o.silent + o.late > o.players) usage(`--silent + --late (${o.silent + o.late}) can't exceed --players (${o.players}).`);
  o.api = o.api.replace(/\/$/, '');
  return o;
}

const opts = parseArgs(process.argv.slice(2));

// ---------- bookkeeping ----------
const T0 = performance.now();
const log = (msg) => console.log(`[${((performance.now() - T0) / 1000).toFixed(1).padStart(6)}s] ${msg}`);

class Fatal extends Error {}
let finished = false;
const failures = new Map(); // "area: message" -> { count, who: [] }
const warnings = new Map();

function note(map, key, who) {
  const row = map.get(key) || { count: 0, who: [] };
  row.count += 1;
  if (who && row.who.length < 6) row.who.push(who);
  map.set(key, row);
}
const fail = (area, message, who) => { if (!finished) note(failures, `${area}: ${message}`, who); };
const warn = (message, who) => { if (!finished) note(warnings, message, who); };

const lat = {
  register: [], connect: [], join: [], answer: [], answerDropped: [], answerLate: [],
  showDelay: [], showSpread: [], resultSpread: [], endSpread: [],
};
const counts = {
  httpRetries: 0, acksOk: 0, acksFailed: 0, pushes: 0, drops: 0, storms: 0, busy: 0, syncs: 0, recovered: 0,
  lateProbes: 0, lateRejected: 0, loginFallbacks: 0, excused: 0, tooLate: 0,
};
const throughput = [];
const bursts = []; // per question: { first, last, n } of the on-time answers (sent -> acked)
const refusals = []; // in-window answers refused with "Too late!": judged after the game (see verifyRefusals)
const serverStats = { local: false, throttled: false }; // the dev server's /__local/stats (reset at the start)

// Resolves waiters whenever any client's state changes; a waiter resolves with its test's value, or null on timeout.
const waiters = new Set();
function waitFor(test, timeoutMs) {
  const now = test();
  if (now) return Promise.resolve(now);
  return new Promise((resolve) => {
    const w = { test, resolve, timer: setTimeout(() => { waiters.delete(w); resolve(null); }, timeoutMs) };
    waiters.add(w);
  });
}
function changed() {
  for (const w of [...waiters]) {
    const v = w.test();
    if (!v) continue;
    clearTimeout(w.timer);
    waiters.delete(w);
    w.resolve(v);
  }
}

// The game everyone plays: shows/results hold the first copy any client saw (push or snapshot).
const game = { code: null, total: 0, shows: new Map(), results: new Map(), end: null, endAt: NaN, started: false, startedAt: 0 };
const clock = { offset: 0, rtt: 0 }; // offset = server clock - local clock (ms), from one ping

const describeError = (err) => `${err?.status || 'no response'}: ${err?.message ?? err}`;
const api = (path, { method = 'GET', body, token } = {}) =>
  request(opts.api, path, { method, body, token, onRetry: () => { counts.httpRetries += 1; } });

/** JSON from the local dev server's /__local/* endpoints, or null when not available (e.g. a real deployment). */
async function localJson(path) {
  try {
    const r = await http(opts.api, path);
    return r.status === 200 && r.body && typeof r.body === 'object' && !('raw' in r.body) ? r.body : null;
  } catch {
    return null;
  }
}

// ---------- one browser tab ----------
class Tab {
  constructor(user, label, { isHost = false } = {}) {
    this.user = user; // { id, username, token } - shared by the tabs of one user
    this.label = label;
    this.isHost = isHost;
    this.inGame = false;
    this.shows = new Map(); // index -> { at, via, data }
    this.results = new Map();
    this.end = null;
    this.room = null; // latest room:state
    this.phaseV = -Infinity; // highest v among phase pushes, to spot reordered pushes
    this.lobbySnap = null; // latest lobby snapshot from a hello/sync ack
    this.opens = 0;
    this.hellos = 0;
    this.nextSyncAt = 0;
    // Deliberate outages (drop / storm). One lasts from the drop until a hello is acked on the new socket: only then has
    // the server re-attached the tab, so a phase that came and went before that can't have reached it.
    this.offlineSince = null;
    this.outages = []; // [{ from, to }], to excuse phases that ended meanwhile
    this.gen = 0; // bumped by every goOffline(), so a hello sent before a drop doesn't end the outage
    this.notInGameAt = []; // when a hello said "not in a game" before this tab had game:end (judged in verifyGame)
  }

  /** Opens the socket like the page does (hello on every open). Resolves true once the first hello was acked. */
  start() {
    const t0 = performance.now();
    this.rt = new Realtime(opts.ws, () => this.user.token, { WebSocket: WebSocketImpl });
    this.rt.on('open', () => {
      this.opens += 1;
      this.hello('hello');
    });
    this.rt.on('busy', (busy) => { if (busy) counts.busy += 1; });
    for (const event of PUSHES) this.rt.on(event, (data) => this.onPush(event, data));
    return waitFor(() => this.hellos > 0, CONNECT_TIMEOUT_MS).then((ok) => {
      if (ok) lat.connect.push(performance.now() - t0);
      else fail('connect', 'no successful hello within 60 s', this.label);
      return !!ok;
    });
  }

  /** send() with failure accounting. `quiet`: the caller checks the outcome itself. */
  async call(event, data = {}, { quiet = false } = {}) {
    const t0 = performance.now();
    let ack;
    try {
      ack = await this.rt.send(event, data);
    } catch (err) {
      ack = { ok: false, error: `send threw: ${err?.message || err}` };
    }
    if (!ack || typeof ack !== 'object') ack = { ok: false, error: 'empty ack' };
    if (!quiet) {
      if (ack.ok) counts.acksOk += 1;
      else {
        counts.acksFailed += 1;
        fail('ack', `${event} failed: "${ack.error}"`, this.label);
      }
    }
    return { ...ack, ms: performance.now() - t0 };
  }

  /** 'hello' on every socket open, 'sync' from the watchdog: the ack carries a snapshot of the current phase. */
  async hello(event) {
    if (event === 'sync') counts.syncs += 1;
    const gen = this.gen;
    const ack = await this.call(event, { protocol: PROTOCOL });
    if (gen === this.gen && this.offlineSince != null) {
      this.outages.push({ from: this.offlineSince, to: Date.now() });
      this.offlineSince = null;
    }
    if (!ack.ok) return;
    if (ack.reload) return fail('hello', 'server asked the page to reload (protocol mismatch)', this.label);
    if (ack.user?.id !== this.user.id) fail('protocol', `${event} ack without the user's profile (user.id)`, this.label);
    if (typeof ack.token === 'string') this.user.token = ack.token; // refreshed token, stored like the page does
    this.hellos += 1;
    if (ack.inGame && ack.snapshot) this.applySnapshot(ack.snapshot, event);
    else if (ack.final?.code && ack.final.code === game.code) this.markEnd(ack.final, event, Date.now());
    else if (this.inGame && !this.end && game.code) this.notInGameAt.push(Date.now());
    changed();
  }

  applySnapshot(s, via) {
    if (!game.code || s.code !== game.code) return; // e.g. the host's hello before the game exists
    const at = Date.now();
    if (!Number.isFinite(s.v)) fail('protocol', `${via} snapshot has no version stamp (v)`, this.label);
    if (s.status === 'lobby') this.lobbySnap = s;
    else if (s.status === 'question' && s.question) this.markShow(s.question, via, at);
    else if (s.status === 'reveal' && s.result) this.markResult(s.result, via, at);
    else if (s.status === 'ended' && s.final) this.markEnd(s.final, via, at);
    else if (s.status === 'cancelled') fail('flow', 'snapshot says the game was cancelled', this.label);
  }

  /** We cut this tab's socket on purpose (drop or storm). `ms`: keep it offline that long. */
  goOffline(ms) {
    this.gen += 1;
    this.offlineSince ??= Date.now();
    this.rt.reconnect(ms);
  }

  /** Was this tab held offline by us for the whole of [from, until]? */
  awayThroughout(from, until) {
    return this.outages.some((o) => o.from <= from && o.to >= until) || (this.offlineSince != null && this.offlineSince <= from);
  }

  /** Was this tab held offline by us at any moment within [from, until]? */
  awayDuring(from, until) {
    return this.outages.some((o) => o.from <= until && o.to >= from) || (this.offlineSince != null && this.offlineSince <= until);
  }

  /** The page's watchdog: question over by 4 s without a result, reveal over by 4 s without the next phase. */
  overdue(localNow) {
    if (!this.inGame || !game.started || this.end || this.offlineSince != null) return false;
    const serverNow = localNow + clock.offset;
    const k = Math.max(-1, ...this.shows.keys(), ...this.results.keys());
    if (k < 0) return localNow > game.startedAt + 10_000; // never saw the first question
    const res = this.results.get(k)?.data;
    if (res) return Number.isFinite(res.revealEndsAt) && serverNow > res.revealEndsAt + WATCHDOG_MS;
    const q = this.shows.get(k).data;
    return serverNow > (q.acceptUntil ?? q.endsAt + 1500) + WATCHDOG_MS;
  }

  onPush(event, data) {
    counts.pushes += 1;
    const at = Date.now();
    if (!data || typeof data !== 'object') return fail('protocol', `${event} without data`, this.label);
    if (!game.code || (event === 'game:cancelled' && data.code !== game.code)) return; // e.g. a cancelled first attempt
    if (data.code !== game.code) return fail('protocol', `${event} for game "${data.code}" (playing ${game.code})`, this.label);
    if (event === 'room:state') this.onRoom(data);
    else if (event === 'answer:count') this.onCount(data);
    else if (event === 'game:cancelled') fail('flow', `game:cancelled pushed (${data.reason})`, this.label);
    else {
      this.checkOrder(event, data);
      if (event === 'question:show') this.markShow(data, 'push', at);
      else if (event === 'question:result') this.markResult(data, 'push', at);
      else this.markEnd(data, 'push', at);
    }
    changed();
  }

  checkOrder(event, data) {
    if (!Number.isFinite(data.v)) return fail('protocol', `${event} has no version stamp (v)`, this.label);
    if (data.v < this.phaseV) fail('order', `${event} (v=${data.v}) arrived after a newer phase (v=${this.phaseV})`, this.label);
    else if (data.v === this.phaseV) warn(`a phase push arrived twice (${event})`, this.label);
    this.phaseV = Math.max(this.phaseV, data.v);
  }

  onRoom(s) {
    if (!Array.isArray(s.players)) return fail('protocol', 'room:state without a players list', this.label);
    if (!this.isHost && s.players.length > 24) fail('lobby', `a player's room:state lists ${s.players.length} players (max 24)`, this.label);
    if (game.started) warn('room:state arrived after the game started (clients ignore it)', this.label);
    this.room = s;
  }

  onCount(c) {
    if (!Number.isInteger(c.index) || !(c.answered >= 0) || (Number.isFinite(c.total) && c.answered > c.total)) {
      fail('protocol', `odd answer:count ${JSON.stringify(c).slice(0, 100)}`, this.label);
    }
  }

  markShow(q, via, at) {
    if (!Number.isInteger(q.index)) return fail('protocol', `question (${via}) without index`, this.label);
    if (q.correctIndex !== undefined) fail('leak', `question (${via}) reveals correctIndex before the reveal`, this.label);
    if (this.shows.has(q.index)) return;
    this.shows.set(q.index, { at, via, data: q });
    if (via !== 'push') counts.recovered += 1;
    if (!game.shows.has(q.index)) game.shows.set(q.index, q);
  }

  markResult(r, via, at) {
    if (!Number.isInteger(r.index)) return fail('protocol', `question:result (${via}) without index`, this.label);
    if (this.results.has(r.index)) return;
    this.results.set(r.index, { at, via, data: r });
    if (via !== 'push') counts.recovered += 1;
    if (!game.results.has(r.index)) game.results.set(r.index, r);
  }

  markEnd(e, via, at) {
    if (this.end) return;
    this.end = { at, via, data: e };
    if (via !== 'push') counts.recovered += 1;
    if (!game.end) {
      game.end = e;
      game.endAt = at;
    }
  }
}

// ---------- steps ----------
async function prepareQuestions() {
  let r;
  try {
    const login = await api('/api/auth/login', { method: 'POST', body: { email: opts.adminEmail, password: opts.adminPassword } });
    if (login?.user?.role !== 'admin') throw new Error(`${opts.adminEmail} is not an admin`);
    r = await ensureLoadTestQuestions((path, o) => api(path, o), login.token, opts.questions);
  } catch (err) {
    throw new Fatal(`could not prepare the "${LOAD_CATEGORY}" questions as admin ${opts.adminEmail} (--admin-email / --admin-password): ${describeError(err)}`);
  }
  log(`"${LOAD_CATEGORY}" questions: ${r.existing} existing, ${r.created} created, ${r.fixed} timers fixed`);
  return r;
}

async function registerOne(run, name) {
  const body = { email: `lt.${run}.${name}@load.test`, username: `lt${run}_${name}`, password: PASSWORD };
  const t0 = performance.now();
  const done = (data) => {
    lat.register.push(performance.now() - t0);
    return { id: data.user.id, username: data.user.username, token: data.token };
  };
  try {
    return done(await api('/api/auth/register', { method: 'POST', body }));
  } catch (err) {
    // Like the sign-up page: a 409 on the email can mean an earlier, timed-out attempt worked. Log in instead.
    if (err?.status === 409 && err.field === 'email') {
      for (const wait of [0, 1000]) {
        await sleep(wait);
        try {
          const data = await api('/api/auth/login', { method: 'POST', body: { email: body.email, password: PASSWORD } });
          counts.loginFallbacks += 1;
          return done(data);
        } catch { /* once more */ }
      }
    }
    fail('http', `POST /api/auth/register -> ${describeError(err)}`, body.username);
    return null;
  }
}

async function registerAll(count) {
  const run = tag(3);
  log(`signing up ${count} accounts at once (${count - 1} players + a presenter host), run id ${run} ...`);
  const t0 = performance.now();
  const users = await Promise.all(Array.from({ length: count }, (_, i) => registerOne(run, i === 0 ? 'host' : String(i))));
  const secs = (performance.now() - t0) / 1000;
  const ok = users.filter(Boolean).length;
  throughput.push(`sign-ups: ${ok} in ${secs.toFixed(1)} s = ${(ok / secs).toFixed(1)}/s`);
  log(`signed up ${ok}/${count} in ${secs.toFixed(1)} s`);
  return users;
}

/** Server clock minus ours, from the quickest of a few pings (a ping's ack carries serverNow). */
async function measureClock(tab) {
  let best = null;
  for (let i = 0; i < 5; i++) {
    const t0 = Date.now();
    const ack = await tab.call('ping', {});
    const t1 = Date.now();
    if (!ack.ok || !Number.isFinite(ack.serverNow)) break;
    if (!best || t1 - t0 < best.rtt) best = { offset: ack.serverNow - (t0 + t1) / 2, rtt: t1 - t0 };
  }
  if (!best) {
    warn('the ping ack has no serverNow: assuming the server clock matches ours');
    return { offset: 0, rtt: 1000 };
  }
  return best;
}

async function createGame(host, refreshedQuestions) {
  for (let attempt = 1; ; attempt++) {
    const ack = await host.call('game:create', {
      categories: [LOAD_CATEGORY], count: opts.questions, hostPlays: false, requestId: `lt-${tag(8)}`,
    });
    if (!ack.ok) throw new Fatal(`game:create failed: ${ack.error}`);
    const total = ack.snapshot?.total;
    if (total === opts.questions || !refreshedQuestions || attempt === 2) return ack;
    // A deployed server caches questions for 30 s per container; ours may be newer than that cache.
    warn(`the first game got ${total} of ${opts.questions} questions (server question cache): created it again after 31 s`);
    await host.call('game:cancel', {});
    await sleep(31_000);
  }
}

const pickPercent = (list, pct) => shuffle(list).slice(0, Math.round((list.length * pct) / 100));

// ---------- the run ----------
const tabs = []; // every tab, for storms and coverage
const answers = []; // { k, userId, label, choice, ok, kind }
const tasks = []; // answer promises, awaited before verification

function recordAnswer(p, k, choice, acks, kind) {
  const ok = acks.some((a) => a.ok);
  for (const a of acks) {
    if (a.ok && a.locked !== true) fail('protocol', 'answer ack without locked: true', p.label);
    if (a.ok && a.index !== undefined && a.index !== k) fail('protocol', `answer ack for question ${k + 1} says index ${a.index}`, p.label);
  }
  answers.push({ k, userId: p.user.id, label: p.label, choice, ok, kind });
  const ms = Math.max(...acks.map((a) => a.ms));
  if (ok) (kind === 'dropped' ? lat.answerDropped : kind === 'late' ? lat.answerLate : lat.answer).push(ms);
}

/**
 * One answer:submit. A "Too late!" is not a failure yet: verifyRefusals() decides after the game whether the answer
 * may really have missed the deadline. Any other refusal is a failure.
 */
async function submitAnswer(tab, k, choice, kind) {
  const sentAt = Date.now();
  const ack = await tab.call('answer:submit', { code: game.code, index: k, choice }, { quiet: true });
  if (ack.ok) counts.acksOk += 1;
  else if (ack.error === 'Too late!') {
    counts.tooLate += 1;
    refusals.push({ tab, k, kind, sentAt, ackAt: Date.now() });
  } else {
    counts.acksFailed += 1;
    fail('ack', `answer:submit failed: "${ack.error}"`, tab.label);
  }
  return ack;
}

async function answerOnTime(p, k, { dropMs, twin, burst, markSent }) {
  const seen = await waitFor(() => p.shows.get(k), SHOW_TIMEOUT_MS);
  if (!seen) {
    markSent();
    return fail('flow', `never saw question ${k + 1}`, p.label);
  }
  if (opts.spread) await sleep(randInt(opts.spread + 1));
  const choice = randInt(seen.data.options?.length || 2);
  const senders = twin ? [p, twin] : [p]; // a second tab of the same player answers too, at the same moment
  const sentAt = performance.now();
  burst.first = Math.min(burst.first, sentAt);
  const pending = senders.map((tab) => submitAnswer(tab, k, choice, dropMs ? 'dropped' : 'onTime'));
  markSent();
  if (dropMs) {
    // The frame is already on the wire; the ack dies with the socket, so realtime.js has to resend after reconnecting.
    counts.drops += 1;
    p.goOffline(dropMs);
  }
  const acks = await Promise.all(pending);
  if (!dropMs && acks.every((a) => a.ok)) {
    burst.last = Math.max(burst.last, performance.now());
    burst.n += 1;
  }
  recordAnswer(p, k, choice, acks, dropMs ? 'dropped' : 'onTime');
}

async function answerLate(p, k, endsAtLocal) {
  const seen = await waitFor(() => p.shows.get(k), SHOW_TIMEOUT_MS);
  if (!seen) return fail('flow', `never saw question ${k + 1}`, p.label);
  await sleep(endsAtLocal - randInt(501) - Date.now()); // the last 500 ms before the timer hits zero
  const choice = randInt(seen.data.options?.length || 2);
  recordAnswer(p, k, choice, [await submitAnswer(p, k, choice, 'late')], 'late');
}

/** An answer for question k after its result was out: must be refused with "Too late!" and never counted. */
async function answerTooLate(p, k) {
  const ack = await p.call('answer:submit', { code: game.code, index: k, choice: 0 }, { quiet: true });
  counts.lateProbes += 1;
  if (ack.ok) fail('late', `an answer sent after question ${k + 1} closed was accepted`, p.label);
  else if (ack.error !== 'Too late!') fail('late', `a too-late answer got "${ack.error}" instead of "Too late!"`, p.label);
  else counts.lateRejected += 1;
}

function storm(where) {
  counts.storms += 1;
  log(`reconnect storm during ${where}: dropping all ${tabs.length} sockets at once`);
  for (const t of tabs) t.goOffline(); // back after the usual full-jitter backoff
}

// One timer for every tab's watchdog; the sync itself waits 0-2 s of jitter like the page.
setInterval(() => {
  const now = Date.now();
  for (const t of tabs) {
    if (now < t.nextSyncAt || !t.overdue(now)) continue;
    t.nextSyncAt = now + 5000;
    setTimeout(() => t.hello('sync'), randInt(2001));
  }
}, 1000).unref();

async function main() {
  log(`Quibble load test: ${opts.players} players x ${opts.questions} questions | spread ${opts.spread} ms, silent ${opts.silent}, `
    + `late ${opts.late}, drop ${opts.drop}%, reconnect storms ${opts.reconnectStorm ? 'on' : 'off'}`);
  log(`API ${opts.api} | WS ${opts.ws}`);
  const capacity = await localJson('/__local/capacity?reset=1');
  serverStats.local = !!(await localJson('/__local/stats?reset=1'));
  if (!capacity) log('no /__local/capacity (not the local dev server): per-key capacity is not checked');
  else if (capacity.enabled === false && opts.capacity) {
    fail('capacity', 'the dev server does not track DynamoDB capacity: restart it with LOCAL_TRACK_CAPACITY=1 (or pass --capacity off)');
    log('! capacity tracking is OFF on the dev server: this run will FAIL the capacity check (LOCAL_TRACK_CAPACITY=1)');
  } else log(`capacity counters reset (tracking ${capacity.enabled === false ? 'OFF' : 'on'})`);

  const added = await prepareQuestions();

  // 1. Everyone signs up at the same moment (one IP).
  const [hostUser, ...playerUsers] = await registerAll(opts.players + 1);
  if (!hostUser) throw new Fatal('the presenter host could not sign up');

  // 2. Everyone opens the page: one socket each, plus a second tab for the first player.
  const host = new Tab(hostUser, 'host', { isHost: true });
  const players = playerUsers.flatMap((u, i) => (u ? [new Tab(u, `p${i + 1}`)] : []));
  if (!players.length) throw new Fatal('no player could sign up');
  const twin = players[0];
  const tab2 = new Tab(twin.user, `${twin.label}-tab2`);
  tabs.push(host, ...players, tab2);
  log(`opening ${tabs.length} sockets ...`);
  let t0 = performance.now();
  const opened = await Promise.all(tabs.map((t) => t.start()));
  log(`${opened.filter(Boolean).length}/${tabs.length} sockets open and greeted in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  if (!opened[0]) throw new Fatal('the host could not connect');
  Object.assign(clock, await measureClock(host));

  // 3. The presenter host creates the game.
  const created = await createGame(host, added.created > 0 || added.fixed > 0);
  game.code = created.code;
  game.total = created.snapshot?.total ?? opts.questions;
  host.inGame = true;
  if (!/^[A-Z2-9]{6}$/.test(game.code || '')) fail('protocol', `odd game code "${game.code}"`);
  if (game.total !== opts.questions) fail('setup', `the game has ${game.total} questions, wanted ${opts.questions}`);
  if (created.snapshot?.isPlayer !== false) fail('protocol', 'a presenter host\'s snapshot should say isPlayer: false');
  log(`game ${game.code} created (${game.total} questions)`);

  // 4. Everyone joins at once; the second tab joins in the same burst.
  log(`${players.length} players join at once (+1 duplicate tab) ...`);
  t0 = performance.now();
  await Promise.all([...players, tab2].map(async (p) => {
    const ack = await p.call('room:join', { code: game.code });
    if (!ack.ok) return;
    p.inGame = true;
    if (p !== tab2) lat.join.push(ack.ms);
    const s = ack.snapshot;
    if ((ack.code !== undefined && ack.code !== game.code) || s?.code !== game.code || s?.status !== 'lobby' || s?.isPlayer !== true || !Number.isFinite(s?.v)) {
      fail('protocol', 'a join ack is not {code, snapshot: {v, code, status: "lobby", isPlayer: true}}', p.label);
    }
    if (!Array.isArray(s?.players) || s.players.length > 24 || !s.players.some((x) => x.userId === p.user.id)) {
      fail('lobby', `a join snapshot's players list doesn't hold the joiner within 24 entries (${s?.players?.length ?? 'none'})`, p.label);
    }
  }));
  const joinSecs = (performance.now() - t0) / 1000;
  const roster = players.filter((p) => p.inGame);
  throughput.push(`joins: ${roster.length} in ${joinSecs.toFixed(1)} s = ${(roster.length / joinSecs).toFixed(1)}/s`);
  log(`${roster.length}/${players.length} joined in ${joinSecs.toFixed(1)} s`);

  // The presenter's lobby lists everybody (players only see the newest 24 - checked on every room:state). A lobby push
  // that went missing is healed by the page's lobby watchdog (sync after 30 s without news): do that sooner here.
  let lobby = await waitFor(() => host.room?.playerCount === roster.length && host.room, 15_000);
  if (!lobby) {
    warn(`the host's room:state never showed all ${roster.length} players (last: ${host.room?.playerCount ?? 'none'}): synced like the lobby watchdog`);
    await host.hello('sync');
    lobby = host.lobbySnap?.playerCount === roster.length ? host.lobbySnap : null;
    if (!lobby) fail('lobby', `neither room:state nor a sync showed the host all ${roster.length} players (sync: ${host.lobbySnap?.playerCount ?? 'none'})`);
  }
  if (lobby) {
    const listed = (lobby.players || []).filter((x) => x.userId !== host.user.id).length;
    if (listed !== roster.length) fail('lobby', `the host's lobby lists ${listed} of ${roster.length} players`);
  }

  // 5. One player leaves and rejoins, and the host starts right away: a lobby broadcast is still in flight.
  const churn = roster.find((p) => p !== twin);
  if (churn) {
    if ((await churn.call('room:leave', {})).ok) churn.inGame = false;
    if ((await churn.call('room:join', { code: game.code })).ok) churn.inGame = true;
  }
  const started = await host.call('game:start', {});
  if (!started.ok) throw new Fatal(`game:start failed: ${started.error}`);
  game.started = true;
  game.startedAt = Date.now();
  log('game started');

  // 6. Questions. Cohorts: silent players never answer; late ones answer in the last 500 ms; on-time ones answer at
  //    once (or spread), and --drop % of them lose their socket right after answering. The twin always answers on
  //    time from both tabs.
  const inGame = players.filter((p) => p.inGame);
  const others = shuffle(inGame.filter((p) => p !== twin));
  const nSilent = Math.min(opts.silent, others.length);
  const nLate = Math.min(opts.late, others.length - nSilent);
  const silent = others.slice(0, nSilent);
  const late = others.slice(nSilent, nSilent + nLate);
  const onTime = [...(twin.inGame ? [twin] : []), ...others.slice(nSilent + nLate)];
  const probes = silent.slice(0, 2);
  const stormQ = Math.floor(game.total / 3);
  const stormR = game.total >= 2 ? Math.min(game.total - 2, Math.floor((2 * game.total) / 3)) : -1; // never the final reveal
  if (opts.reconnectStorm && stormR < 0) warn('one question only: no reconnect storm during a reveal');
  if (!probes.length) warn('no silent players: the too-late answer check was skipped');

  for (let k = 0; k < game.total; k++) {
    const show = await waitFor(() => game.shows.get(k), SHOW_TIMEOUT_MS);
    if (!show) {
      fail('flow', `question ${k + 1} never started`);
      break;
    }
    if (show.timeLimit !== LOAD_TIME_LIMIT) warn(`a question has a ${show.timeLimit} s timer instead of ${LOAD_TIME_LIMIT} s (server question cache?)`);
    const endsAtLocal = show.endsAt - clock.offset;
    const acceptUntilLocal = (show.acceptUntil ?? show.endsAt + 1500) - clock.offset;
    const droppers = new Set(pickPercent(onTime.filter((p) => p !== twin), opts.drop));
    const burst = { first: Infinity, last: 0, n: 0 };
    bursts[k] = burst;
    let unsent = onTime.length;
    let allSent;
    const sentAll = new Promise((r) => { allSent = r; if (!unsent) r(); });
    const markSent = () => { if (--unsent === 0) allSent(); };
    for (const p of onTime) {
      const dropMs = droppers.has(p) ? 1000 + randInt(4001) : 0;
      tasks.push(answerOnTime(p, k, { dropMs, twin: p === twin && tab2.inGame ? tab2 : null, burst, markSent }));
    }
    for (const p of late) tasks.push(answerLate(p, k, endsAtLocal));
    if (opts.reconnectStorm && k === stormQ) {
      await Promise.race([sentAll, sleep(10_000)]); // right after the on-time burst: most acks are still in flight
      storm(`question ${k + 1}`);
    }
    const closeWaitMs = Number.isFinite(acceptUntilLocal) ? Math.max(0, acceptUntilLocal - Date.now()) + 30_000 : 60_000;
    const result = await waitFor(() => game.results.get(k), closeWaitMs);
    if (!result) {
      fail('flow', `question ${k + 1} never closed`);
      break;
    }
    log(`Q${k + 1}/${game.total}: ${result.answeredCount}/${result.playerCount} answered, ${droppers.size} dropped mid-question`);
    for (const p of probes) tasks.push(answerTooLate(p, k));
    if (opts.reconnectStorm && k === stormR) storm(`reveal ${k + 1}`);
  }

  // 7. The end: every tab must see game:end (push, or the final board from a hello).
  if (!(await waitFor(() => game.end, END_TIMEOUT_MS))) fail('flow', 'game:end never arrived');
  const watchers = [host, ...players.filter((p) => p.inGame), ...(tab2.inGame ? [tab2] : [])];
  await Promise.all(watchers.map((t) => waitFor(() => t.end, 20_000)));
  await Promise.all(tasks);
  log('game over; checking ...');

  const finalRoster = players.filter((p) => p.inGame); // after the leave + rejoin above
  await readServerStats();
  verifyGame(host, watchers, finalRoster);
  verifyRefusals();
  await verifyHistory(finalRoster.filter((p) => p.end?.data?.me), finalRoster.length);
  await verifyCapacity();
}

// ---------- checks ----------
/** When a phase first reached any tab (NaN if never). */
function firstAt(pick) {
  const ats = tabs.map(pick).filter(Boolean).map((x) => x.at);
  return ats.length ? Math.min(...ats) : NaN;
}

/** v of the first pushed copy of a phase (snapshots may nest the phase without its own v). */
const pushedV = (pick) => tabs.map(pick).find((x) => x?.via === 'push' && Number.isFinite(x.data.v))?.data.v;

/**
 * Every tab must get every phase by push or snapshot - except a tab we kept offline for the whole time the phase was
 * current (from its first delivery anywhere until the next phase began): no snapshot can bring back a past phase.
 */
const FANOUT_SLACK_MS = 250;

function coverage(watchers, has, from, to, label) {
  if (!Number.isFinite(from)) return; // nobody got it: already reported by the flow
  const until = Number.isFinite(to) ? to : Infinity;
  const lost = [];
  for (const t of watchers) {
    if (has(t)) continue;
    // A push reaches tabs over a few ms (fan-out lag). A tab cut off in that window (e.g. a storm triggered by the
    // first copy) may not have its copy yet; if it stays offline until the next phase, nothing can bring it back.
    if (t.awayThroughout(from + FANOUT_SLACK_MS, until)) counts.excused += 1;
    else lost.push(t);
  }
  if (lost.length) fail('coverage', `${lost.length} tab(s) never got ${label}`, lost.slice(0, 6).map((t) => t.label).join(', '));
}

function verifyGame(host, watchers, roster) {
  const expectedCorrect = new Map(roster.map((p) => [p.user.id, 0]));
  const endAt = firstAt((t) => t.end);
  // A hello may say "not in a game" only once the game is over (then game:end coverage below decides).
  for (const t of watchers) {
    if (t.notInGameAt.some((at) => !(at >= endAt - 2000))) fail('recovery', 'a hello said "not in a game" while the game was still running', t.label);
  }
  for (let k = 0; k < game.total; k++) {
    const res = host.results.get(k)?.data ?? game.results.get(k);
    const showAt = firstAt((t) => t.shows.get(k));
    const resultAt = firstAt((t) => t.results.get(k));
    const nextAt = k + 1 < game.total ? firstAt((t) => t.shows.get(k + 1)) : endAt;
    coverage(watchers, (t) => t.shows.has(k), showAt, resultAt, `question:show ${k + 1}`);
    coverage(watchers, (t) => t.results.has(k), resultAt, nextAt, `question:result ${k + 1}`);
    const vShow = pushedV((t) => t.shows.get(k));
    const vResult = pushedV((t) => t.results.get(k));
    const vNext = pushedV((t) => (k + 1 < game.total ? t.shows.get(k + 1) : t.end));
    if ((Number.isFinite(vShow) && Number.isFinite(vResult) && !(vShow < vResult))
      || (Number.isFinite(vResult) && Number.isFinite(vNext) && !(vResult < vNext))) {
      fail('order', `question ${k + 1}: version stamps don't increase (show ${vShow}, result ${vResult}, next phase ${vNext})`);
    }
    if (!res) continue; // already reported by the flow
    const accepted = new Map(); // userId -> choice (two tabs of one player count once)
    for (const a of answers) if (a.k === k && a.ok) accepted.set(a.userId, a.choice);
    const optionCounts = Array.isArray(res.optionCounts) ? res.optionCounts : [];
    const sum = optionCounts.reduce((s, n) => s + n, 0);
    const q = `question ${k + 1}`;
    if (sum !== res.answeredCount) fail('count', `${q}: optionCounts add up to ${sum}, answeredCount is ${res.answeredCount}`);
    if (res.answeredCount !== accepted.size) fail('count', `${q}: answeredCount ${res.answeredCount}, but ${accepted.size} answers were acked ok`);
    optionCounts.forEach((n, c) => {
      const want = [...accepted.values()].filter((x) => x === c).length;
      if (n !== want) fail('count', `${q}: option ${c} counted ${n}, ${want} acked`);
    });
    if (res.playerCount !== roster.length) fail('count', `${q}: playerCount ${res.playerCount}, roster ${roster.length}`);
    if (!Number.isInteger(res.correctIndex)) fail('protocol', `${q}: question:result without correctIndex`);
    const show = game.shows.get(k);
    if (show && (res.text !== show.text || JSON.stringify(res.options) !== JSON.stringify(show.options))) {
      fail('protocol', `${q}: question:result text/options differ from question:show`);
    }
    for (const p of rankProblems(Array.isArray(res.leaderboard) ? res.leaderboard : [])) fail('scoring', `${q} leaderboard: ${p}`);
    for (const [userId, choice] of accepted) if (choice === res.correctIndex) expectedCorrect.set(userId, (expectedCorrect.get(userId) || 0) + 1);
    // Personalised part: myChoice is what this player's accepted answer was (null without one).
    for (const t of watchers) {
      const mine = t.results.get(k)?.data;
      if (!mine) continue;
      const want = t.isHost ? undefined : accepted.get(t.user.id);
      const got = mine.myChoice ?? null;
      if (want === undefined ? got !== null : got?.choice !== want) {
        fail('scoring', `myChoice in result ${k + 1} is ${JSON.stringify(got)}, expected choice ${want ?? 'none'}`, t.label);
      } else if (got && (got.correct !== (got.choice === mine.correctIndex) || !(got.gained >= 0) || (!got.correct && got.gained !== 0))) {
        fail('scoring', `myChoice in result ${k + 1} is inconsistent: ${JSON.stringify(got)} (correct option ${mine.correctIndex})`, t.label);
      }
      if (t.isHost && mine.me != null) fail('scoring', `the presenter host got a "me" row in result ${k + 1}`, t.label);
    }
  }

  // Final board. A tab we held offline when game:end went out may have missed it for good: once the game is disposed
  // the server no longer knows the player was in it, so a later hello can't hand back the final board.
  coverage(watchers, (t) => !!t.end, endAt, endAt, 'game:end');
  const end = host.end?.data ?? game.end;
  if (!end) return;
  if (end.playerCount !== roster.length) fail('end', `game:end playerCount ${end.playerCount}, roster ${roster.length}`);
  const board = Array.isArray(end.leaderboard) ? end.leaderboard : [];
  if (board.length !== Math.min(10, roster.length)) fail('end', `game:end leaderboard has ${board.length} rows`);
  for (const p of rankProblems(board)) fail('end', `leaderboard: ${p}`);
  if (host.end?.data && host.end.data.me != null) fail('end', 'the presenter host got a "me" row');
  for (const p of roster) {
    const me = p.end?.data?.me;
    if (!p.end) continue;
    if (!me) {
      fail('end', 'game:end without a "me" row for a player', p.label);
      continue;
    }
    if (me.correctCount !== expectedCorrect.get(p.user.id)) {
      fail('scoring', `final correctCount ${me.correctCount}, expected ${expectedCorrect.get(p.user.id)}`, p.label);
    }
    const gains = [...Array(game.total).keys()].map((k) => p.results.get(k)?.data?.myChoice?.gained ?? (p.results.has(k) ? 0 : NaN));
    const total = gains.reduce((s, g) => s + g, 0);
    if (Number.isFinite(total) && total !== me.score) fail('scoring', `final score ${me.score}, but the results' gains add up to ${total}`, p.label);
  }
}

/**
 * Answers sent inside the window but refused with "Too late!". An answer reached the server at the latest when its ack
 * left (ack time + clock offset), so:
 *   - acked clearly before acceptUntil: it arrived in time and was refused anyway -> failure. This includes an answer
 *     whose socket dropped right after sending it: the question must not close without it.
 *   - its tab was held offline between the question appearing and the answer being SENT: the question may have
 *     closed early meanwhile (everyone connected had answered) -> excused.
 *   - otherwise it may really have arrived after acceptUntil. Fine for the deliberately late cohort; for on-time
 *     answers only when the server was visibly overloaded (throttling or resends: SPEC "deadline-bound actions may
 *     still fail" at Lambda concurrency 10), else a failure.
 */
function verifyRefusals() {
  const margin = 200 + clock.rtt / 2;
  // Locally the emulator says whether it throttled; against AWS, resends ("busy" episodes) are the only sign.
  const overloaded = serverStats.local ? serverStats.throttled : counts.busy > 0;
  const excused = { away: 0, late: 0, onTime: 0 };
  for (const { tab, k, kind, sentAt, ackAt } of refusals) {
    const show = game.shows.get(k);
    const acceptUntil = show?.acceptUntil ?? (show?.endsAt ?? NaN) + 1500;
    const shownAt = tab.shows.get(k)?.at ?? -Infinity;
    const what = `${kind === 'late' ? 'a last-500-ms' : kind === 'dropped' ? 'an on-time (then dropped)' : 'an on-time'} answer to question ${k + 1}`;
    const spareMs = Math.round(acceptUntil - (ackAt + clock.offset));
    if (tab.awayDuring(shownAt, sentAt)) excused.away += 1;
    else if (spareMs > margin) fail('late', `${what} was refused ("Too late!") although it reached the server >= ${spareMs} ms before acceptUntil`, tab.label);
    else if (kind === 'late') excused.late += 1;
    else if (overloaded) excused.onTime += 1;
    else fail('late', `${what} was refused ("Too late!"): it took until acceptUntil to be handled, with no throttling or resends seen`, tab.label);
  }
  if (excused.late) warn(`${excused.late} last-500-ms answer(s) may have reached the server after acceptUntil and were refused`);
  if (excused.onTime) warn(`${excused.onTime} on-time answer(s) missed acceptUntil while the server was throttled (deadline-bound actions may fail at low Lambda concurrency)`);
  if (excused.away) warn(`${excused.away} answer(s) were refused after their tab was offline during the question (it may have closed early)`);
}

async function verifyHistory(finishers, rosterSize) {
  if (!finishers.length && rosterSize) fail('history', 'no player has a final "me" row to check /api/me/history against');
  const sample = shuffle(finishers).slice(0, 10);
  await Promise.all(sample.map(async (p) => {
    try {
      const h = await api('/api/me/history', { token: p.user.token });
      const row = h?.games?.find((g) => g.code === game.code);
      const me = p.end.data.me;
      if (!row) fail('history', 'the game is missing from /api/me/history', p.label);
      else if (row.score !== me.score || row.rank !== me.rank) {
        fail('history', `history says score ${row.score} rank ${row.rank}, game:end said ${me.score} / ${me.rank}`, p.label);
      }
    } catch (err) {
      fail('http', `GET /api/me/history -> ${describeError(err)}`, p.label);
    }
  }));
  if (sample.length) log(`history checked for ${sample.length} players`);
}

let capacityLines = [];
async function verifyCapacity() {
  if (!opts.capacity) return void capacityLines.push('not checked (--capacity off)');
  const cap = await localJson('/__local/capacity');
  if (!cap) {
    warn('per-key DynamoDB capacity was not checked (no /__local/capacity: not the local dev server)');
    return void capacityLines.push('not checked (no /__local/capacity on this server: watch the CloudWatch throttle alarms)');
  }
  if (cap.enabled === false) return void capacityLines.push('NOT CHECKED: tracking is off (start the dev server with LOCAL_TRACK_CAPACITY=1)');
  if (!cap.busiestWriteKeys?.length && !cap.busiestReadKeys?.length) {
    fail('capacity', 'capacity tracking is on but recorded no partition keys at all');
  }
  const share = opts.capacityPct / 100;
  const wMax = (cap.limitsPerPartition?.writePerSec ?? 1000) * share;
  const rMax = (cap.limitsPerPartition?.readPerSec ?? 3000) * share;
  const keys = new Map();
  for (const k of [...(cap.busiestWriteKeys || []), ...(cap.busiestReadKeys || []), ...(cap.keys || [])]) keys.set(`${k.table}|${k.key}`, k);
  for (const k of keys.values()) {
    if (k.peakWritePerSec > wMax) fail('capacity', `${k.table} key "${k.key}" peaked at ${k.peakWritePerSec} WCU/s (limit ${wMax})`);
    if (k.peakReadPerSec > rMax) fail('capacity', `${k.table} key "${k.key}" peaked at ${k.peakReadPerSec} RCU/s (limit ${rMax})`);
  }
  const top = (list, field, unit) => (list || []).slice(0, 3).map((k) => `${k.key} ${k[field]} ${unit}`).join(', ') || '-';
  capacityLines.push(`busiest write keys: ${top(cap.busiestWriteKeys, 'peakWritePerSec', 'WCU/s')} (limit ${wMax})`);
  capacityLines.push(`busiest read keys:  ${top(cap.busiestReadKeys, 'peakReadPerSec', 'RCU/s')} (limit ${rMax})`);
  capacityLines.push('(transactions span several keys and are only counted per table)');
}

// The dev server's emulator counters since the start of this run: throttling we caused, and handler crashes the
// clients' retries may have hidden.
let statsLines = [];
async function readServerStats() {
  if (!serverStats.local) return;
  const s = await localJson('/__local/stats');
  if (!s) return;
  const sum = (o) => Object.values(o || {}).reduce((n, v) => n + (Number(v) || 0), 0);
  const fmt = (o) => Object.entries(o || {}).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(', ') || '0';
  serverStats.throttled = sum(s.throttles) > 0;
  statsLines.push(`Lambda concurrency limit ${s.concurrencyLimit ?? 'none'}, peak in flight ${s.peakInFlight ?? '-'}`);
  statsLines.push(`invocations: ${fmt(s.invocations)} | throttled: ${fmt(s.throttles)} | handler errors: ${fmt(s.errors)}`);
  statsLines.push(`timer events re-queued ${s.timer?.requeued ?? 0}, retried ${s.timer?.retried ?? 0}, dropped ${s.timer?.dropped ?? 0} | `
    + `$disconnect dropped ${sum(s.disconnectsDropped)} | pushes sent ${s.pushes?.sent ?? '-'}, gone ${s.pushes?.gone ?? '-'}`);
  if (sum(s.errors)) warn(`${sum(s.errors)} handler run(s) threw on the dev server (${fmt(s.errors)}): see its log`);
  if (s.timer?.dropped) warn(`${s.timer.dropped} GameTimer event(s) were dropped by the emulated async queue`);
}

// ---------- report ----------
function pushLatencies() {
  const spread = (pick, into) => {
    const ats = tabs.map(pick).filter((x) => x?.via === 'push').map((x) => x.at);
    const first = Math.min(...ats);
    for (const at of ats) into.push(at - first);
  };
  for (let k = 0; k < game.total; k++) {
    spread((t) => t.shows.get(k), lat.showSpread);
    spread((t) => t.results.get(k), lat.resultSpread);
    for (const t of tabs) {
      const s = t.shows.get(k);
      if (s?.via !== 'push' || !Number.isFinite(s.data.endsAt)) continue;
      const limitMs = s.data.timeLimit < 1000 ? s.data.timeLimit * 1000 : s.data.timeLimit;
      lat.showDelay.push(s.at + clock.offset - (s.data.endsAt - limitMs));
    }
  }
  spread((t) => t.end, lat.endSpread);
}

function printSummary() {
  pushLatencies();
  const fmt = (v) => (Number.isFinite(v) ? String(Math.round(v)) : '-').padStart(7);
  const rows = [
    ['sign-up (POST register)', lat.register], ['socket open + hello', lat.connect], ['room:join ack', lat.join],
    ['answer ack', lat.answer], ['answer ack after a drop', lat.answerDropped], ['late answer ack', lat.answerLate],
    ['question:show after open', lat.showDelay], ['question:show fan-out lag', lat.showSpread],
    ['question:result fan-out lag', lat.resultSpread], ['game:end fan-out lag', lat.endSpread],
  ];
  const answerRates = bursts.filter((b) => b && b.n > 1 && b.last > b.first).map((b) => (b.n * 1000) / (b.last - b.first));
  if (answerRates.length) {
    const s = summarize(answerRates);
    throughput.push(`on-time answers acked: median ${s.p50.toFixed(0)}/s, best ${s.max.toFixed(0)}/s per question burst`);
  }
  const secs = (performance.now() - T0) / 1000;
  throughput.push(`pushes received: ${counts.pushes} in ${secs.toFixed(0)} s = ${(counts.pushes / secs).toFixed(0)}/s`);
  const reconnects = tabs.reduce((n, t) => n + Math.max(0, t.opens - 1), 0);
  const accepted = answers.filter((a) => a.ok).length;

  console.log('\n================ Quibble load test ================');
  console.log(`game ${game.code ?? '-'}: ${tabs.filter((t) => t.inGame && !t.isHost).length} player tabs, ${game.total} questions, ${accepted} answers accepted, `
    + `${counts.tooLate} in-window answers refused as too late, ${counts.lateRejected}/${counts.lateProbes} after-the-close probes refused`);
  console.log(`acks ok ${counts.acksOk}, failed ${counts.acksFailed} | HTTP retries ${counts.httpRetries} | drops ${counts.drops}, storms ${counts.storms}, `
    + `reconnects ${reconnects} | watchdog syncs ${counts.syncs} | phases recovered from snapshots ${counts.recovered} | "busy" episodes ${counts.busy}`
    + (counts.loginFallbacks ? ` | sign-ups finished by login ${counts.loginFallbacks}` : '')
    + (counts.excused ? ` | phases missed while we held a tab offline ${counts.excused}` : ''));
  console.log(`\n${'latency (ms)'.padEnd(30)}${'n'.padStart(7)}${'p50'.padStart(7)}${'p95'.padStart(7)}${'max'.padStart(7)}`);
  for (const [name, values] of rows) {
    const s = summarize(values);
    console.log(`  ${name.padEnd(28)}${String(s.n).padStart(7)}${fmt(s.p50)}${fmt(s.p95)}${fmt(s.max)}`);
  }
  console.log('\nthroughput');
  for (const line of throughput) console.log(`  ${line}`);
  console.log('\nDynamoDB capacity per partition key');
  for (const line of capacityLines.length ? capacityLines : ['not checked (the run stopped early)']) console.log(`  ${line}`);
  if (statsLines.length) {
    console.log('\nlocal emulator (since the start of this run)');
    for (const line of statsLines) console.log(`  ${line}`);
  }
  const list = (map, prefix) => {
    const entries = [...map].sort((a, b) => b[1].count - a[1].count);
    for (const [msg, { count, who }] of entries.slice(0, 60)) {
      console.log(`  ${prefix} ${msg}${count > 1 ? ` (x${count})` : ''}${who.length ? ` [${who.join(', ')}${count > who.length ? ', ...' : ''}]` : ''}`);
    }
    if (entries.length > 60) console.log(`  ... and ${entries.length - 60} more`);
  };
  if (warnings.size) {
    console.log('\nwarnings');
    list(warnings, '-');
  }
  if (failures.size) {
    console.log('\nFAILURES');
    list(failures, 'x');
  }
  console.log(`\nRESULT: ${failures.size ? `FAIL (${failures.size} distinct problems)` : 'PASS'}`);
}

let finishing = false;
async function finish() {
  if (finishing) return;
  finishing = true;
  try {
    printSummary();
  } catch (err) {
    console.error('could not print the summary:', err);
    note(failures, `crash: summary failed: ${err?.message || err}`);
  }
  finished = true; // closing the sockets below must not count as failures
  for (const t of tabs) {
    try { t.rt?.close(); } catch { /* already closed */ }
  }
  await sleep(300); // let the close frames go out
  process.exit(failures.size ? 1 : 0);
}

process.on('unhandledRejection', (err) => fail('crash', String(err?.stack || err).split('\n').slice(0, 3).join(' | ')));
process.on('uncaughtException', (err) => {
  fail('crash', String(err?.stack || err).split('\n').slice(0, 3).join(' | '));
  finish();
});
const budgetMs = 240_000 + opts.questions * 45_000 + opts.players * 300;
setTimeout(() => {
  fail('flow', `the run took longer than ${Math.round(budgetMs / 1000)} s`);
  finish();
}, budgetMs).unref();

main()
  .catch((err) => fail(err instanceof Fatal ? 'flow' : 'crash', err instanceof Fatal ? err.message : String(err?.stack || err)))
  .finally(finish);
