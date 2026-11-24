// The game state machine (lobby -> question -> reveal -> ... -> ended), built so 250 players can join and answer at
// the same moment without contention. Storage layout: lib/gamedata.js. Payloads: lib/views.js. Design: README.
//
// - The game header (GamesTable) is ~1 KB and only changes on phase changes. Every phase change is ONE DynamoDB
//   transaction conditioned on the header's version, status and question index, so exactly one caller wins it; the
//   winner schedules the next timer FIRST and then pushes the new phase to everyone.
// - Hot paths never rewrite shared state: a join is one atomic counter + one new item; an answer is one new item + one
//   atomic update of the question's small "gate" item. Each item family has its own partition key.
// - Every action is idempotent, because browsers resend anything that wasn't acknowledged.
// - Lost timers are recovered: the question timer takes over a stalled close, and any player's `hello`/`sync` (sent by
//   the browser's watchdog when a deadline passes without news) un-sticks an overdue game.
import { DeleteCommand, PutCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, scanAll, nowIso, sleep } from './db.js';
import { env } from './config.js';
import { GameError } from './errors.js';
import { pickRandom } from './questions.js';
import { getQuiz } from './quizzes.js';
import * as Q from './qtypes.js';
import { maskImages } from './images.js';
import { getUserById, setCurrentGame, clearCurrentGame, userKey, publicUser, lockJoin, unlockJoin } from './users.js';
import { signToken } from './auth.js';
import { connectionsForUser, setConnectionGame, clearConnectionGame, deleteConnectionRecord, anySocketAlive } from './connections.js';
import { emitToMembers, disconnectUser } from './push.js';
import { scheduleAdvance } from './timer.js';
import { saveResults, refreshBoards } from './results.js';
import { log, metric } from './log.js';
import * as gd from './gamedata.js';
import * as V from './views.js';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I to avoid typos
const LOBBY_TTL_MS = 3 * 60 * 60 * 1000; // organisers often open the room long before everyone arrives
const KEEP_FINISHED_DAYS = 30; // DynamoDB TTL removes old game headers after this
const PLAY_TTL_DAYS = 1; // per-game items (players, answers, gates...)
const TAKEOVER_MS = 5000; // a close claimed this long ago that never finished was abandoned: take it over
const LOBBY_CLAIM_STALE_MS = 10_000; // a lobby push claimed this long ago lost its timer
const UNSTICK_LEASE_MS = 10_000;
const TOKEN_REFRESH_S = 24 * 60 * 60;
const COUNT_POLL_MS = 1000; // the question timer pushes "x / y answered" at most this often
const REPAIR_QUIET_MS = 10_000; // only repair the lobby's player counter after this long without a join
const JOIN_WAIT_MS = 6000; // a second join of the same player waits this long for the first one's result
const EARLY_SKEW_MS = 2000; // an answer can't have reached AWS more than this long before its question opened
// After a question's close is claimed, answers that reached API Gateway BEFORE that instant still count if their Lambda
// runs within this window (e.g. a player whose socket dropped right after tapping). Then the gate is sealed.
const SETTLE_MS = 500;
const MEMBERS_CACHE_MS = 5000;
// The sweep (every 2 minutes) ends games nobody is in any more, so nothing stays "live" overnight:
const IDLE_LOBBY_MS = 10 * 60 * 1000; // a lobby nobody has had open for this long (the host and every player left)
const IDLE_PLAYING_MS = 3 * 60 * 1000; // a game in play that every player and the host left this long ago
const FROZEN_MS = 2 * 60 * 1000; // a phase this far past its deadline that un-sticking couldn't move on
const MAX_GAME_MS = 4 * 60 * 60 * 1000; // nothing stays live longer than this, whatever the reason

const T = () => env.gamePlayTable;
const playTtl = () => gd.ttlAfterDays(PLAY_TTL_DAYS);

// ---------- small DynamoDB helpers ----------
const update = (TableName, Key, e, extra = {}) => ddb.send(new UpdateCommand({ TableName, Key, ...gd.expr(e), ...extra }));

/** `SET #a = :f_a, ...` for every defined field. */
function setExpr(fields) {
  const parts = [];
  const values = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    parts.push(`#${k} = :f_${k}`);
    values[`:f_${k}`] = v;
  }
  return { update: `SET ${parts.join(', ')}`, values };
}

/** Transaction item: header phase change, only if nobody changed the header since `h` was read. */
function headerUpdate(h, fields, { status, k } = {}) {
  const s = setExpr({ ...fields, version: h.version + 1 });
  let condition = '#version = :v0 AND #status = :s0';
  const values = { ...s.values, ':v0': h.version, ':s0': status ?? h.status };
  if (k !== undefined) {
    condition += ' AND #qIndex = :k0';
    values[':k0'] = k;
  }
  return { TableName: env.gamesTable, Key: { code: h.code }, ...gd.expr({ update: s.update, condition, values }) };
}

/**
 * Commit a transaction. False if a condition failed (someone else already made this change, or the state moved on).
 * Conflicts and throttling are retried here.
 */
async function commit(items) {
  for (let attempt = 0; ; attempt++) {
    try {
      await ddb.send(new TransactWriteCommand({ TransactItems: items }));
      return true;
    } catch (err) {
      if (!gd.isTxCancelled(err)) throw err;
      if (gd.reasonCodes(err).includes('ConditionalCheckFailed')) return false;
      if (attempt >= 4) throw err;
      await sleep(50 * 2 ** attempt + Math.random() * 50);
    }
  }
}

const ignoreCheckFailed = (err) => {
  if (!gd.isCheckFailed(err)) throw err;
};

/** Defer `fn` until after the ack, at most once per request for a given key. */
function deferOnce(ctx, key, fn) {
  if (!ctx?.defer) return;
  ctx.once ??= new Set();
  if (ctx.once.has(key)) return;
  ctx.once.add(key);
  ctx.defer(fn);
}

/** Schedule a timer; on failure log and carry on (the push still goes out; hello's un-stick recovers the timer). */
async function scheduleOrLog(payload) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await scheduleAdvance(payload);
      return;
    } catch (error) {
      if (attempt === 2) log('error', 'scheduling a timer failed', { error, payload });
      else await sleep(100 * (attempt + 1));
    }
  }
}

const safely = (what, fn) => async (...args) => {
  try {
    return await fn(...args);
  } catch (error) {
    log('error', `${what} failed`, { error });
    return undefined;
  }
};

// ---------- presence: which sockets belong to which member ----------
/** Add a socket to a member's `conns`. True if the member had no open socket before (came online). */
async function addConn(code, userId, connectionId) {
  try {
    const res = await update(T(), gd.keys.member(code, userId), {
      update: 'ADD #conns :c',
      condition: 'attribute_exists(#sk)',
      values: { ':c': new Set([connectionId]) },
    }, { ReturnValues: 'UPDATED_OLD' });
    const old = res.Attributes?.conns;
    return !old || old.size === 0;
  } catch (err) {
    ignoreCheckFailed(err);
    return false;
  }
}

/**
 * Remove a socket from a member's `conns` and stamp `seenAt` (the member was here until now; the sweep uses it to
 * tell how long a room has been empty). Returns { member, wentOffline } or null if it wasn't there.
 */
async function removeConn(code, userId, connectionId) {
  try {
    const res = await update(T(), gd.keys.member(code, userId), {
      update: 'DELETE #conns :c SET #seenAt = :now',
      condition: 'attribute_exists(#sk) AND contains(#conns, :cid)',
      values: { ':c': new Set([connectionId]), ':cid': connectionId, ':now': Date.now() },
    }, { ReturnValues: 'ALL_NEW' });
    const member = res.Attributes;
    return { member, wentOffline: !member?.conns || member.conns.size === 0 };
  } catch (err) {
    ignoreCheckFailed(err);
    return null;
  }
}

/** Nudge the "everyone answered" hint of question k by +1/-1 for a player who hasn't answered. Returns the gate. */
async function adjustExpected(code, k, seat, delta) {
  try {
    const res = await update(T(), gd.keys.gate(code, k), {
      update: 'ADD #expected :d',
      condition: 'attribute_exists(#sk) AND attribute_not_exists(#closedAt) AND NOT contains(#seats, :seat)',
      values: { ':d': delta, ':seat': seat },
    }, { ReturnValues: 'ALL_NEW' });
    return res.Attributes;
  } catch (err) {
    ignoreCheckFailed(err);
    return null;
  }
}

/**
 * Subscribe this socket (by primary key, never via an eventually consistent index) and the user's other tabs to the
 * game. Returns true if the member just came online.
 */
async function attach(user, code, member, ctx, header) {
  const seat = member?.seat ?? 0;
  let cameOnline = false;
  if (ctx?.connectionId && (await setConnectionGame(ctx.connectionId, code, seat))) {
    cameOnline = await addConn(code, user.id, ctx.connectionId);
  }
  try {
    // Also re-point tabs already in this game with an old seat (left and re-joined the lobby).
    const others = (await connectionsForUser(user.id)).filter((c) => c.connectionId !== ctx?.connectionId && (c.gameCode !== code || c.seat !== seat));
    for (const c of others) {
      if (await setConnectionGame(c.connectionId, code, seat)) cameOnline = (await addConn(code, user.id, c.connectionId)) || cameOnline;
    }
  } catch (error) {
    log('warn', 'attaching other tabs failed', { error, code });
  }
  if (cameOnline && V.isPlayer(member)) {
    if (header?.status === 'question') await adjustExpected(code, header.qIndex, member.seat, +1);
    if (header?.status === 'lobby') deferOnce(ctx, `lobby:${code}`, () => requestLobbyBroadcast(code));
  }
  return cameOnline;
}

/** A member's last socket closed. */
async function onOffline(code, member) {
  const h = await gd.getHeader(code);
  if (!h || !V.isLive(h)) return;
  if (h.status === 'lobby') return requestLobbyBroadcast(code);
  if (h.status === 'question' && V.isPlayer(member)) {
    const gate = await adjustExpected(code, h.qIndex, member.seat, -1);
    if (gate && gate.answered >= gate.expected) await maybeCloseEarly(code, h.qIndex);
  }
}

/** Sockets that turned out to be closed during a push. */
async function cleanupGone(header, gone) {
  await Promise.all(gone.map(async ({ member, connectionId }) => {
    await deleteConnectionRecord(connectionId).catch(() => {});
    const r = await removeConn(header.code, member.userId, connectionId).catch(() => null);
    if (r?.wentOffline && header.status === 'question' && V.isPlayer(member)) {
      await adjustExpected(header.code, header.qIndex, member.seat, -1).catch(() => null);
    }
  }));
}

/** Push to every member's sockets (see push.emitToMembers) and forget sockets that are gone. Never throws. */
async function broadcast(header, members, event, dataFn) {
  try {
    const gone = await emitToMembers(members, event, dataFn);
    if (gone.length) await cleanupGone(header, gone);
  } catch (error) {
    log('error', `broadcast ${event} failed`, { error, code: header.code });
  }
}

// ---------- lobby ----------
/** Take a seat at the lobby gate: { seat, count }. */
async function claimSeat(code, retried = false) {
  try {
    const res = await update(T(), gd.keys.lobby(code), {
      update: 'ADD #seq :one, #count :one SET #lastClaimAt = :now',
      condition: 'attribute_exists(#sk) AND #open = :t AND #count < #max',
      values: { ':one': 1, ':t': true, ':now': Date.now() },
    }, { ReturnValues: 'UPDATED_NEW', ReturnValuesOnConditionCheckFailure: 'ALL_OLD' });
    return { seat: res.Attributes.seq, count: res.Attributes.count };
  } catch (err) {
    ignoreCheckFailed(err);
    const lobby = gd.plain(err.Item) ?? (await gd.getLobby(code));
    if (!lobby) throw new GameError('No game with that code.');
    if (lobby.open !== true) throw new GameError('That game has already started.');
    // The counter can drift up if a join died between counting and writing its player: recount and repair once.
    // Only when no seat was claimed for a while, so joins still writing their player item are never miscounted
    // (that would let more than MAX_PLAYERS in during a burst).
    const quietFor = Date.now() - (lobby.lastClaimAt ?? 0);
    if (!retried && lobby.count >= lobby.max && quietFor > REPAIR_QUIET_MS) {
      const real = await gd.countRoster(code);
      if (real < lobby.count) {
        await update(T(), gd.keys.lobby(code), {
          update: 'SET #count = :n',
          condition: '#count = :seen AND (attribute_not_exists(#lastClaimAt) OR #lastClaimAt < :quiet)',
          values: { ':n': real, ':seen': lobby.count, ':quiet': Date.now() - REPAIR_QUIET_MS },
        }).catch(ignoreCheckFailed);
        return claimSeat(code, true);
      }
    }
    throw new GameError('That game is full.');
  }
}

const releaseSeat = (code) =>
  update(T(), gd.keys.lobby(code), { update: 'ADD #count :neg', values: { ':neg': -1 } })
    .catch((error) => log('warn', 'releasing a lobby seat failed', { error, code }));

/**
 * Ask for the lobby list to be pushed within BROADCAST_WINDOW_MS. Joins arriving in that window piggyback on the same
 * push, so a crowd joining causes ~2 pushes a second instead of one per join.
 */
async function requestLobbyBroadcast(code) {
  const now = Date.now();
  const claims = await gd.getClaims(code); // strong: a stale copy could hide that the pending push already ran
  if (claims?.lobbyDue && claims.lobbyDue > now - LOBBY_CLAIM_STALE_MS) return; // a push is pending and will include us
  const due = now + env.broadcastWindowMs;
  try {
    await update(T(), gd.keys.claims(code), {
      update: 'SET #lobbyDue = :due, #expiresAt = if_not_exists(#expiresAt, :exp)',
      condition: 'attribute_not_exists(#lobbyDue) OR #lobbyDue < :stale',
      values: { ':due': due, ':exp': playTtl(), ':stale': now - LOBBY_CLAIM_STALE_MS },
    });
  } catch (err) {
    ignoreCheckFailed(err);
    return;
  }
  try {
    await scheduleAdvance({ kind: 'lobby', code, due, dueAt: due });
  } catch (err) {
    await update(T(), gd.keys.claims(code), { update: 'REMOVE #lobbyDue', condition: '#lobbyDue = :due', values: { ':due': due } }).catch(() => {});
    throw err;
  }
}

async function lobbyTimer({ code, due, dueAt }) {
  const wait = (dueAt ?? due) - Date.now();
  if (wait > 0) await sleep(wait);
  try {
    // Release the claim BEFORE reading: anything that changes after this point schedules its own push.
    await update(T(), gd.keys.claims(code), { update: 'REMOVE #lobbyDue', condition: '#lobbyDue = :due', values: { ':due': due } });
  } catch (err) {
    ignoreCheckFailed(err);
    return; // a newer claim owns the next push
  }
  const h = await gd.getHeader(code);
  if (!V.isLive(h) || h.status !== 'lobby') return;
  const members = await gd.queryMembers(code);
  const full = V.roomState(h, members, { all: true });
  const recent = V.roomState(h, members, { all: false });
  await broadcast(h, members, 'room:state', (m) => (V.seesAllPlayers(h, m) ? full : recent));
}

// ---------- reading a user's game ----------
/** The live game this user belongs to: { header, member } or null. */
async function gameOfUser(user) {
  const code = user.currentGame;
  if (!code) return null;
  const header = await gd.getHeader(code);
  if (!V.isLive(header)) return null;
  const member = await gd.getMember(code, user.id);
  return member ? { header, member } : null;
}

/** What the browser needs to draw the current phase for `viewer` (a member item). */
async function snapshotFor(code, viewer) {
  const h = await gd.getHeader(code);
  if (!h) return null;
  const playing = V.isPlayer(viewer);
  if (h.status === 'lobby') {
    if (V.seesAllPlayers(h, viewer)) return V.lobbySnapshot(h, await gd.queryMembers(code, { consistent: false }), viewer);
    // Players get the full list from the next room:state push; a list query per player would cost O(n^2) reads.
    const lobby = await gd.getLobby(code, { consistent: false });
    return V.lobbySnapshot(h, [viewer], viewer, { playerCount: lobby?.count });
  }
  if (h.status === 'question') {
    const [questions, gate] = await Promise.all([gd.getQuestions(code), gd.getGate(code, h.qIndex)]);
    return V.questionSnapshot(h, questions[h.qIndex], gate, viewer, Date.now());
  }
  if (h.status === 'reveal') {
    const [result, scoresItem] = await Promise.all([gd.getResult(code, h.qIndex), gd.getScores(code)]);
    const base = V.snapshotBase(h, { isPlayer: playing });
    if (!result) return base;
    const { me, myChoice } = V.viewerOf(viewer, { result, scores: scoresItem?.scores ?? {} });
    return { ...base, result: V.questionResult(h, result, { me, myChoice, serverNow: Date.now() }) };
  }
  if (h.status === 'ended') return { ...V.snapshotBase(h, { isPlayer: playing }), final: await finalFor(h, viewer) };
  return V.snapshotBase(h, { isPlayer: playing }); // cancelled
}

/** game:end payload for one viewer, rebuilt from storage (for someone who missed the push). */
async function finalFor(h, viewer) {
  const [result, scoresItem] = await Promise.all([gd.getResult(h.code, h.total - 1), gd.getScores(h.code)]);
  const me = V.isPlayer(viewer) ? V.rowFromScores(scoresItem?.scores ?? {}, viewer) : null;
  return V.gameEnd(h, result?.top10 ?? [], me);
}

/** All items in random order. */
function sampleAll(items) {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Which questions of an n-question game are worth double: always the last one, plus ~1 in 5 others (never the first). */
export function doubleRounds(n, random = Math.random) {
  const out = new Set();
  if (n < 2) return out;
  out.add(n - 1);
  const extra = Math.floor((n - 1) / 5);
  const pool = Array.from({ length: n - 2 }, (_, i) => i + 1); // 1 .. n-2
  for (let i = 0; i < extra && pool.length; i++) out.add(pool.splice(Math.floor(random() * pool.length), 1)[0]);
  return out;
}

// ---------- public operations (WebSocket actions: (user, data, ctx); ctx = { connectionId, conn, now, defer }) ----------
export async function create(user, data, ctx) {
  const requestId = data.requestId || null;
  const fresh = (await getUserById(user.id, { consistent: true })) ?? user;
  let seen = null; // a stale currentGame pointer we may overwrite
  if (fresh.currentGame) {
    const h = await gd.getHeader(fresh.currentGame);
    if (V.isLive(h)) {
      const member = await gd.getMember(h.code, user.id);
      if (member && requestId && h.hostId === user.id && h.createRequestId === requestId) {
        await attach(user, h.code, member, ctx, h); // a resend of a create that already succeeded
        return { code: h.code, snapshot: await snapshotFor(h.code, member) };
      }
      if (member) throw new GameError("You're already in a game. Leave it first.");
    }
    seen = fresh.currentGame;
  }

  let cats = [];
  let picked;
  let quizTitle = null;
  if (data.quizId) {
    // A quiz someone made: its own questions, in its own order (or shuffled).
    const quiz = await getQuiz(data.quizId);
    if (!quiz || (quiz.ownerId !== user.id && !quiz.shared)) throw new GameError("That quiz doesn't exist or isn't shared.");
    if (!quiz.questions?.length) throw new GameError('That quiz has no questions yet.');
    picked = data.shuffle ? sampleAll(quiz.questions) : quiz.questions;
    quizTitle = quiz.title;
  } else {
    cats = [...new Set([...(data.categories || []), ...(data.category ? [data.category] : [])])];
    picked = await pickRandom(cats, data.count, data.types);
    if (!picked.length) {
      throw new GameError(data.types?.length
        ? 'No questions of those types in those categories yet. Pick more types or categories.'
        : `There are no questions for ${cats.length > 1 ? 'those categories' : 'that category'} yet.`);
    }
  }
  const doubles = data.doublePoints ? doubleRounds(picked.length) : new Set();
  // Flag pictures under their per-deploy alias (the file name would give the answer away); other images dropped.
  const questions = picked.map((q, i) => Q.prepareQuestion({ ...q, text: maskImages(q.text) }, { double: doubles.has(i) }));

  const rid = requestId || `none-${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  // Big-screen mode: the host's screen is the projector, so the host never plays from it.
  const bigScreen = !!data.bigScreen;
  const hostPlays = !!data.hostPlays && !bigScreen;
  for (let attempt = 0; ; attempt++) {
    const now = Date.now();
    const code = Array.from({ length: 6 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
    const header = {
      code, status: 'lobby', version: 1, hostId: user.id, hostName: user.username, hostPlays, bigScreen,
      quizTitle, doublePoints: !!data.doublePoints,
      category: quizTitle ?? V.categoryLabel(cats), categories: cats, createRequestId: rid, total: questions.length, qIndex: -1,
      questionStartedAt: 0, endsAt: 0, acceptUntil: 0, revealEndsAt: 0, playerCount: hostPlays ? 1 : 0,
      createdAt: nowIso(), lobbyExpiresAt: now + LOBBY_TTL_MS, expiresAt: gd.ttlAfterDays(KEEP_FINISHED_DAYS), resultsSaved: false,
    };
    const host = {
      ...gd.keys.member(code, user.id), userId: user.id, username: user.username,
      seat: hostPlays ? 1 : 0, presenter: !hostPlays, joinedAt: now, expiresAt: playTtl(),
    };
    const userCondition = [
      seen ? '(attribute_not_exists(#currentGame) OR #currentGame = :seen)' : 'attribute_not_exists(#currentGame)',
      '(attribute_not_exists(#createRequestId) OR #createRequestId <> :rid)',
    ].join(' AND ');
    try {
      await ddb.send(new TransactWriteCommand({
        TransactItems: [
          { Put: { TableName: env.gamesTable, Item: header, ...gd.expr({ condition: 'attribute_not_exists(#code)' }) } },
          { Put: { TableName: T(), Item: { ...gd.keys.meta(code), questions, expiresAt: playTtl() } } },
          { Put: { TableName: T(), Item: { ...gd.keys.lobby(code), open: true, seq: hostPlays ? 1 : 0, count: hostPlays ? 1 : 0, max: env.maxPlayers, expiresAt: playTtl() } } },
          { Put: { TableName: T(), Item: host } },
          {
            Update: {
              TableName: env.usersTable,
              Key: userKey(user.id),
              ...gd.expr({
                update: 'SET #currentGame = :code, #createRequestId = :rid',
                condition: userCondition,
                values: { ':code': code, ':rid': rid, ':seen': seen },
              }),
            },
          },
        ],
      }));
      gd.rememberQuestions(code, questions);
      await attach(user, code, host, ctx, header);
      metric('GamesCreated');
      return { code, snapshot: V.lobbySnapshot(header, [host], host) };
    } catch (err) {
      if (!gd.isTxCancelled(err)) throw err;
      const reasons = gd.reasonCodes(err);
      if (reasons[4] === 'ConditionalCheckFailed') {
        // Another create (this one's resend, or another tab) got there first.
        const now2 = await getUserById(user.id, { consistent: true });
        const h = now2?.currentGame ? await gd.getHeader(now2.currentGame) : null;
        if (h && requestId && now2.createRequestId === requestId) {
          if (!V.isLive(h)) throw new GameError('That game was cancelled.'); // a resend of a create whose game is gone
          const member = await gd.getMember(h.code, user.id);
          await attach(user, h.code, member, ctx, h);
          return { code: h.code, snapshot: await snapshotFor(h.code, member) };
        }
        throw new GameError("You're already in a game. Leave it first.");
      }
      if (attempt >= 6) throw new GameError('The server is busy, please try again.');
      if (reasons[0] !== 'ConditionalCheckFailed') await sleep(50 * 2 ** attempt); // conflict/throttle; else a code clash
    }
  }
}

export async function join(user, { code }, ctx) {
  const h = await gd.getHeader(code);
  if (!h) throw new GameError('No game with that code.');
  if (h.status === 'cancelled') throw new GameError('That game was cancelled.');
  if (!V.isLive(h)) throw new GameError('No game with that code.');

  let member = await gd.getMember(code, user.id);
  if (member) return rejoin(user, code, member, ctx, h);

  if (user.currentGame && user.currentGame !== code && (await gameOfUser(user))) {
    throw new GameError("You're already in another game.");
  }
  if (h.status !== 'lobby') throw new GameError('That game has already started.');

  // One join per player at a time: a second tab, or this join resent because it was slow, waits for the first.
  const token = await lockJoin(user.id, code);
  if (!token) return joinInFlight(user, code, ctx);
  return joinLocked(user, code, ctx, h, token);
}

/** joinSeat under this player's join lock; a join that got a seat released it with its currentGame write. */
async function joinLocked(user, code, ctx, h, token) {
  const lock = { released: false };
  try {
    return await joinSeat(user, code, ctx, h, lock);
  } finally {
    if (!lock.released) await unlockJoin(user.id, token).catch((error) => log('warn', 'releasing a join lock failed', { error, code }));
  }
}

/** Another join of this player into this game is running: wait for its member item, then attach this socket too. */
async function joinInFlight(user, code, ctx) {
  const until = Date.now() + JOIN_WAIT_MS;
  while (Date.now() < until) {
    await sleep(150 + Math.random() * 100);
    const [m, h] = await Promise.all([gd.getMember(code, user.id), gd.getHeader(code)]);
    if (m && V.isLive(h)) return rejoin(user, code, m, ctx, h);
    if (!V.isLive(h)) throw new GameError(h?.status === 'cancelled' ? 'That game was cancelled.' : 'No game with that code.');
    const fresh = await getUserById(user.id, { consistent: true });
    if (fresh?.joining !== code) {
      // That join finished without a seat (full, started, failed). Try once more ourselves.
      const again = await gd.getMember(code, user.id);
      if (again) return rejoin(user, code, again, ctx, h);
      const token = await lockJoin(user.id, code);
      if (token) return joinLocked(user, code, ctx, h, token);
    }
  }
  throw new GameError('Joining is taking longer than usual. Please try again.');
}

/** The seat claim and member write of a join (the caller holds the player's join lock). */
async function joinSeat(user, code, ctx, h, lock) {
  if (h.status !== 'lobby') throw new GameError('That game has already started.');
  // (The caller checked for a member item just before taking the lock. Should another join of this player have
  // finished in between, the member write below fails and this join falls back to rejoining.)
  let claimed;
  try {
    claimed = await claimSeat(code);
  } catch (err) {
    // Two tabs of the same player joining at once: the other tab may have just taken this player's seat.
    const mine = err instanceof GameError ? await gd.getMember(code, user.id) : null;
    if (mine) return rejoin(user, code, mine, ctx, h);
    throw err;
  }
  const { seat, count } = claimed;
  const member = {
    ...gd.keys.member(code, user.id), userId: user.id, username: user.username,
    seat, presenter: false, joinedAt: Date.now(), expiresAt: playTtl(),
  };
  try {
    await ddb.send(new PutCommand({ TableName: T(), Item: member, ...gd.expr({ condition: 'attribute_not_exists(#sk)' }) }));
  } catch (err) {
    await releaseSeat(code);
    if (!gd.isCheckFailed(err)) throw err;
    const existing = await gd.getMember(code, user.id); // the same user joined from two tabs at once
    if (existing) return rejoin(user, code, existing, ctx, h);
    throw err;
  }
  await setCurrentGame(user.id, code, { releaseJoin: true });
  lock.released = true;
  await attach(user, code, member, ctx, h);
  const after = await gd.getHeader(code);
  if (!V.isLive(after)) {
    // Cancelled while we were joining: undo, so this player isn't left in a dead room.
    await ddb.send(new DeleteCommand({ TableName: T(), Key: gd.keys.member(code, user.id) })).catch(() => {});
    await releaseSeat(code);
    await clearCurrentGame(user.id, code);
    if (ctx?.connectionId) await clearConnectionGame(ctx.connectionId, code).catch(() => {});
    throw new GameError('That game was cancelled.');
  }
  deferOnce(ctx, `lobby:${code}`, () => requestLobbyBroadcast(code));
  metric('PlayersJoined');
  // The host may have started while this join was in flight: then send the real phase, not a lobby.
  if (after.status !== 'lobby') return { code, snapshot: await snapshotFor(code, member) };
  return { code, snapshot: V.lobbySnapshot(after, [member], member, { playerCount: count }) };
}

async function rejoin(user, code, member, ctx, h) {
  if (user.currentGame !== code) await setCurrentGame(user.id, code);
  await attach(user, code, member, ctx, h);
  return { code, snapshot: await snapshotFor(code, member) };
}

export async function leave(user, data, ctx) {
  const code = user.currentGame;
  if (!code) return {};
  const h = await gd.getHeader(code);
  if (!V.isLiveStatus(h?.status)) {
    await clearCurrentGame(user.id, code);
    return {};
  }
  if (h.hostId === user.id) {
    await cancel(code, 'The host left the game.');
    return {};
  }
  const lobby = await gd.getLobby(code);
  if (h.status !== 'lobby' || lobby?.open === false) throw new GameError("You can't leave a game that's in progress.");
  try {
    await ddb.send(new DeleteCommand({ TableName: T(), Key: gd.keys.member(code, user.id), ...gd.expr({ condition: 'attribute_exists(#sk)' }) }));
    await releaseSeat(code);
  } catch (err) {
    ignoreCheckFailed(err); // already gone: a resend
  }
  await clearCurrentGame(user.id, code);
  if (ctx?.connectionId) await clearConnectionGame(ctx.connectionId, code);
  ctx?.defer?.(() => requestLobbyBroadcast(code));
  return {};
}

export async function start(user) {
  const code = user.currentGame;
  const h = code ? await gd.getHeader(code) : null;
  if (!h || h.hostId !== user.id || !V.isLiveStatus(h.status)) throw new GameError('Only the host can start the game.');
  if (h.status !== 'lobby') return {}; // a resend after the game already started

  // Close the gate so nobody joins mid-start. If it is already closed, a previous attempt died: resume it.
  let count;
  try {
    const res = await update(T(), gd.keys.lobby(code), {
      update: 'SET #open = :f, #closedAt = :now',
      condition: '#open = :t',
      values: { ':f': false, ':t': true, ':now': Date.now() },
    }, { ReturnValues: 'ALL_NEW' });
    count = res.Attributes.count;
  } catch (err) {
    ignoreCheckFailed(err);
    count = (await gd.getLobby(code))?.count ?? 0;
  }
  const ok = await beginGame(code, h, count);
  metric('GamesStarted');
  if (!ok) {
    const after = await gd.getHeader(code);
    if (after?.status === 'lobby') throw new GameError('The server is busy, please try again.');
  }
  return {};
}

/** Wait for joins that passed the gate to finish writing their player, then open question 0. */
async function beginGame(code, h, count) {
  let members = await gd.queryMembers(code);
  for (let i = 0; V.rosterOf(members).length < count && i < 15; i++) {
    await sleep(100);
    members = await gd.queryMembers(code);
  }
  if (!V.rosterOf(members).length) {
    await update(T(), gd.keys.lobby(code), { update: 'SET #open = :t REMOVE #closedAt', condition: '#open = :f', values: { ':t': true, ':f': false } })
      .catch(ignoreCheckFailed);
    throw new GameError('Wait for at least one player to join.');
  }
  return openQuestion(code, 0, { header: h, members });
}

/** Opens question k (atomically with its gate). True if this call made the change. */
async function openQuestion(code, k, { header, members } = {}) {
  const questions = await gd.getQuestions(code);
  const q = questions?.[k];
  if (!q) return false;
  members ??= await gd.queryMembers(code);
  const roster = V.rosterOf(members);
  const now = Date.now();
  const endsAt = now + q.timeLimit * 1000;
  const acceptUntil = endsAt + env.lateGraceMs;
  const gate = {
    ...gd.keys.gate(code, k), k, startedAt: now, endsAt, acceptUntil,
    correctIndex: Q.isTapType(Q.typeOf(q)) ? q.correctIndex : -1, optionCount: Q.gateOptionCount(q), timeLimitMs: q.timeLimit * 1000,
    expected: roster.filter(V.isConnected).length, answered: 0, expiresAt: playTtl(),
  };
  const fields = { status: 'question', qIndex: k, questionStartedAt: now, endsAt, acceptUntil };
  if (k === 0) Object.assign(fields, { startedAt: nowIso(), playerCount: roster.length });
  const items = [
    { Put: { TableName: T(), Item: gate, ...gd.expr({ condition: 'attribute_not_exists(#sk)' }) } },
    { Update: headerUpdate(header, fields, k === 0 ? { status: 'lobby' } : { status: 'reveal', k: k - 1 }) },
  ];
  if (k === 0) {
    const scores = Object.fromEntries(roster.map((m) => [m.seat, [0, 0, 0]]));
    items.push({ Put: { TableName: T(), Item: { ...gd.keys.scores(code), scores, through: -1, expiresAt: playTtl() } } });
  }
  if (!(await commit(items))) return false;

  const h = { ...header, ...fields, version: header.version + 1 };
  await scheduleOrLog({ kind: 'question', code, qIndex: k, dueAt: acceptUntil }); // before the push: a timer must exist
  metric('QuestionsAsked');
  await broadcast(h, await gd.queryMembers(code), 'question:show', () => V.questionShow(h, q, { k, endsAt, acceptUntil }, Date.now()));
  return true;
}

export async function submitAnswer(user, data, ctx) {
  const at = ctx?.now ?? Date.now(); // when API Gateway received the answer
  const code = data.code || ctx?.conn?.gameCode || user.currentGame;
  if (!code) throw new GameError("You're not playing in a game.");
  let seat = ctx?.conn?.gameCode === code && ctx.conn.seat > 0 ? ctx.conn.seat : null;
  if (!seat) {
    const m = await gd.getMember(code, user.id);
    if (!V.isPlayer(m)) throw new GameError("You're not playing in a game.");
    seat = m.seat;
  }
  let k = data.index;
  if (k === undefined) {
    const h = await gd.getHeader(code);
    if (h?.status !== 'question') throw new GameError('No question is open right now.');
    k = h.qIndex;
  }

  // The answer must fit the question's type (an option index, a typed word, an order, a number).
  const question = (await gd.getQuestions(code))?.[k];
  if (!question) throw new GameError('No question is open right now.');
  const given = Q.normalizeAnswer(question, data);
  const tap = given.choice !== undefined;

  // 1. Write the answer BEFORE it can be counted, so a counted seat always has its answer on record.
  //    A resend keeps the original answer and arrival time.
  let choice = tap ? given.choice : 0; // non-tap types always pass the gate's option check as option 0
  let answeredAt = at;
  try {
    await ddb.send(new PutCommand({
      TableName: T(),
      Item: { ...gd.keys.answer(code, k, seat), seat, userId: user.id, ...given, at, expiresAt: playTtl() },
      ...gd.expr({ condition: 'attribute_not_exists(#sk)' }),
    }));
  } catch (err) {
    ignoreCheckFailed(err);
    const prev = await gd.getAnswer(code, k, seat);
    if (prev) {
      if (tap && Number.isInteger(prev.choice)) choice = prev.choice;
      answeredAt = prev.at;
    }
  }

  // 2. Count it at the question's gate (one small item; no read-modify-write, so no contention errors).
  //    An answer that arrived before the close instant still counts until the closer seals the gate.
  try {
    const res = await update(T(), gd.keys.gate(code, k), {
      update: 'ADD #answered :one, #seats :seatSet',
      condition: 'attribute_exists(#sk) AND attribute_not_exists(#sealed) AND (attribute_not_exists(#closedAt) OR #closedAt >= :at) AND #acceptUntil >= :at AND #startedAt <= :early AND #optionCount > :choice AND NOT contains(#seats, :seat)',
      values: {
        ':one': 1, ':seatSet': new Set([seat]), ':at': answeredAt, ':choice': choice, ':seat': seat,
        ':early': answeredAt + EARLY_SKEW_MS, // sent before the question even opened: never an instant 1000 points
      },
    }, { ReturnValues: 'ALL_NEW', ReturnValuesOnConditionCheckFailure: 'ALL_OLD' });
    metric('AnswersSubmitted');
    const gate = res.Attributes;
    if (gate.answered >= gate.expected) ctx?.defer?.(() => maybeCloseEarly(code, k));
    return { locked: true, index: k };
  } catch (err) {
    ignoreCheckFailed(err);
    const old = gd.plain(err.Item) ?? (await gd.getGate(code, k));
    if (old && V.seatsOf(old).has(seat)) return { locked: true, index: k }; // already counted: a resend
    const tooEarly = old && old.startedAt > answeredAt + EARLY_SKEW_MS;
    if (!old || tooEarly || !(old.optionCount > choice)) {
      // Not counted and never will be: drop the answer item so the player's real answer isn't mistaken for a resend
      // of this one (e.g. a tap sent for a question that hadn't opened yet).
      await ddb.send(new DeleteCommand({ TableName: T(), Key: gd.keys.answer(code, k, seat) })).catch(() => {});
      throw new GameError(old && !tooEarly ? 'Invalid option.' : 'No question is open right now.');
    }
    throw new GameError('Too late!');
  }
}

/** `answered >= expected` is only a hint: close early only if every connected player really has answered. */
async function maybeCloseEarly(code, k) {
  const [members, gate] = await Promise.all([gd.queryMembers(code), gd.getGate(code, k)]);
  if (!gate || gate.closedAt) return;
  const seats = V.seatsOf(gate);
  const connected = V.rosterOf(members).filter(V.isConnected).map((m) => m.seat);
  // If nobody is connected we never close early: the timer runs so people can reconnect.
  if (connected.length && connected.every((s) => seats.has(s))) {
    await closeQuestion(code, k);
    return;
  }
  const n = new Set([...connected, ...seats]).size;
  await update(T(), gd.keys.gate(code, k), {
    update: 'SET #expected = :n',
    condition: 'attribute_exists(#sk) AND attribute_not_exists(#closedAt)',
    values: { ':n': n },
  }).catch(ignoreCheckFailed);
}

/** Close question k, score it and show the result. Safe to call any number of times, concurrently. */
async function closeQuestion(code, k) {
  try {
    await update(T(), gd.keys.gate(code, k), {
      update: 'SET #closedAt = :now',
      condition: 'attribute_exists(#sk) AND attribute_not_exists(#closedAt)',
      values: { ':now': Date.now() },
    });
    // From here on only answers that arrived before closedAt can still be counted, for SETTLE_MS.
    await sleep(SETTLE_MS);
  } catch (err) {
    ignoreCheckFailed(err);
    const claimed = await gd.getGate(code, k);
    // Someone else is closing it. Only take over if they apparently died.
    if (!claimed?.closedAt || Date.now() - claimed.closedAt < TAKEOVER_MS) return false;
    log('warn', 'taking over a stalled close', { code, k });
  }
  const h = await gd.getHeader(code);
  if (!V.isQuestionAt(h, k)) return false;
  // Seal: no answer at all can be counted after this. ALL_NEW gives the final set of counted seats.
  const sealed = await update(T(), gd.keys.gate(code, k), {
    update: 'SET #sealed = :t',
    condition: 'attribute_exists(#sk)',
    values: { ':t': true },
  }, { ReturnValues: 'ALL_NEW' });
  const gate = sealed.Attributes;

  const seats = V.seatsOf(gate);
  const [answers, members, scoresItem, questions] = await Promise.all([
    gd.queryAnswers(code, k), gd.queryMembers(code), gd.getScores(code), gd.getQuestions(code),
  ]);
  const counted = answers.filter((a) => seats.has(Number(a.seat)));
  const roster = V.rosterOf(members);
  const { scores, board, result } = V.scoreQuestion({
    k, question: questions[k], gate, answers: counted, roster,
    prevScores: scoresItem?.scores ?? {}, playerCount: h.playerCount ?? roster.length,
  });
  const revealEndsAt = Date.now() + env.revealMs;
  const fields = { status: 'reveal', revealEndsAt };
  const ok = await commit([
    { Update: headerUpdate(h, fields, { status: 'question', k }) },
    { Put: { TableName: T(), Item: { ...gd.keys.scores(code), scores, through: k, expiresAt: playTtl() } } },
    { Put: { TableName: T(), Item: { ...gd.keys.result(code, k), ...result, expiresAt: playTtl() } } },
  ]);
  if (!ok) return false;

  const after = { ...h, ...fields, version: h.version + 1 };
  await scheduleOrLog({ kind: 'reveal', code, qIndex: k, dueAt: revealEndsAt });
  const bySeat = new Map(board.map((r) => [r.seat, r]));
  await broadcast(after, await gd.queryMembers(code), 'question:result', (m) => {
    const playing = V.isPlayer(m);
    return V.questionResult(after, result, {
      me: playing ? V.publicRow(bySeat.get(m.seat)) : null,
      myChoice: playing ? V.myChoiceFor(result, scores, m.seat) : null,
      serverNow: Date.now(),
    });
  });
  return true;
}

async function endGame(code) {
  const h = await gd.getHeader(code);
  if (!h) return;
  if (h.status === 'ended' ? h.resultsSaved : !V.isRevealAt(h, h.total - 1)) return;
  const endedAt = h.endedAt ?? new Date(h.revealEndsAt).toISOString(); // deterministic, so saving twice overwrites
  const [members, scoresItem] = await Promise.all([gd.queryMembers(code), gd.getScores(code)]);
  const board = V.rankRows(V.rosterOf(members), scoresItem?.scores ?? {});
  await saveResults({ ...h, endedAt }, board); // before the header says "ended", so results are never lost
  const fields = { status: 'ended', endedAt, resultsSaved: true, awards: V.awardsOf(board), expiresAt: gd.ttlAfterDays(KEEP_FINISHED_DAYS) };
  if (!(await commit([{ Update: headerUpdate(h, fields, { status: h.status }) }]))) return;

  const after = { ...h, ...fields, version: h.version + 1 };
  metric('GamesFinished');
  const top = board.slice(0, V.TOP_N).map(V.publicRow);
  const bySeat = new Map(board.map((r) => [r.seat, r]));
  // Fresh member list: sockets that reconnected during the last reveal must get the final board too. Nobody's
  // currentGame is cleared here: a player who still misses this push gets the final board from their next hello,
  // which clears the pointer itself (create/join already treat a pointer to a finished game as stale).
  const now = await gd.queryMembers(code);
  await broadcast(after, now, 'game:end', (m) => V.gameEnd(after, top, V.isPlayer(m) ? V.publicRow(bySeat.get(m.seat)) : null));
  await safely('refreshBoards', refreshBoards)(); // a full scan: after the push, so it doesn't delay game:end
}

/** Point everyone's currentGame away from a finished game. */
async function dispose(code, members) {
  await Promise.all(members.map((m) => clearCurrentGame(m.userId, code).catch((error) => log('warn', 'clearCurrentGame failed', { error }))));
}

async function cancel(code, reason) {
  // Close the gate first, so no join can complete into a game that is being cancelled.
  await update(T(), gd.keys.lobby(code), { update: 'SET #open = :f', condition: 'attribute_exists(#sk)', values: { ':f': false } })
    .catch(ignoreCheckFailed);
  for (let attempt = 0; attempt < 6; attempt++) {
    const h = await gd.getHeader(code);
    if (!V.isLiveStatus(h?.status)) return false;
    const fields = { status: 'cancelled', cancelReason: reason, endedAt: nowIso(), expiresAt: gd.ttlAfterDays(1) };
    if (await commit([{ Update: headerUpdate(h, fields) }])) {
      const after = { ...h, ...fields, version: h.version + 1 };
      metric('GamesCancelled');
      const members = await gd.queryMembers(code);
      await broadcast(after, members, 'game:cancelled', () => V.gameCancelled(after));
      await dispose(code, members);
      return true;
    }
  }
  return false;
}

export async function cancelByHost(user) {
  const code = user.currentGame;
  const h = code ? await gd.getHeader(code) : null;
  if (!V.isLiveStatus(h?.status)) return {}; // already over: a resend
  if (h.hostId !== user.id) throw new GameError('Only the host can cancel the game.');
  await cancel(code, 'The host cancelled the game.');
  return {};
}

/** Admin panel: end a live game (or an expired lobby) for everyone. False if it was already over. */
export async function forceCancel(code, reason) {
  return cancel(code, reason || 'An admin ended the game.');
}

/** Sent by the browser on every socket open (and as `sync` by its watchdog): resync the user with their game. */
export async function hello(user, data, ctx) {
  if (data?.protocol !== V.PROTOCOL) return { reload: true }; // a tab still running an older app.js
  const out = { user: publicUser(user) };
  const iat = ctx?.conn?.tokenIat;
  if (!iat || Date.now() / 1000 - iat > TOKEN_REFRESH_S) out.token = signToken(user.id, user.sessionVersion);

  const code = user.currentGame;
  if (!code) return { ...out, inGame: false };
  const [h, member] = await Promise.all([gd.getHeader(code), gd.getMember(code, user.id)]);
  if (!h || !member) {
    await clearCurrentGame(user.id, code);
    return { ...out, inGame: false };
  }
  if (!V.isLive(h)) {
    if (h.status === 'lobby') ctx?.defer?.(() => cancel(code, 'The lobby expired.'));
    const final = h.status === 'ended' ? await finalFor(h, member) : undefined;
    await clearCurrentGame(user.id, code);
    return { ...out, inGame: false, ...(final ? { final } : {}) };
  }
  await attach(user, code, member, ctx, h);
  ctx?.defer?.(() => maybeUnstick(code));
  return { ...out, inGame: true, snapshot: await snapshotFor(code, member) }; // read after attaching
}

/** $disconnect: forget the socket; if it was the member's last one they are now offline. */
export async function disconnect(connectionId) {
  const conn = await deleteConnectionRecord(connectionId);
  if (!conn?.gameCode) return;
  const r = await removeConn(conn.gameCode, conn.userId, connectionId);
  if (r?.wentOffline) await onOffline(conn.gameCode, r.member);
}

/** Admin banned someone: remove them from their live game and close their sockets. */
export async function kickUser(userId) {
  const user = await getUserById(userId, { consistent: true });
  const code = user?.currentGame;
  if (code) {
    const h = await gd.getHeader(code);
    if (V.isLiveStatus(h?.status)) {
      if (h.hostId === userId) await cancel(code, 'The host was removed.');
      else {
        let removed = null;
        try {
          const res = await ddb.send(new DeleteCommand({
            TableName: T(), Key: gd.keys.member(code, userId), ReturnValues: 'ALL_OLD', ...gd.expr({ condition: 'attribute_exists(#sk)' }),
          }));
          removed = res.Attributes;
        } catch (err) {
          ignoreCheckFailed(err);
        }
        if (removed && h.status === 'lobby') {
          await releaseSeat(code);
          await requestLobbyBroadcast(code);
        }
        if (removed && h.status === 'question') await maybeCloseEarly(code, h.qIndex);
      }
    }
    await clearCurrentGame(userId, code);
  }
  await disconnectUser(userId);
}

// ---------- emoji reactions (lobby, results, final screen) ----------
// A reaction is one conditional write on the member (at most one per REACT_GAP_MS each) plus one counter bump on one
// of a few shard items. The counters are pushed to everyone at most once per REACT_WINDOW_MS, so a whole room
// tapping away costs ~1 push a second, not one per tap.
const REACT_GAP_MS = 600;
const REACT_WINDOW_MS = 800;
const REACT_AFTER_END_MS = 10 * 60 * 1000;
export const REACTION_KINDS = 8;

const reactionsOpen = (h, now) =>
  !!h && (h.status === 'lobby' || h.status === 'reveal' || (h.status === 'ended' && now - Date.parse(h.endedAt ?? 0) < REACT_AFTER_END_MS));

export async function react(user, { emoji }, ctx) {
  const code = ctx?.conn?.gameCode || user.currentGame;
  if (!code) throw new GameError("You're not in a game.");
  const now = Date.now();
  if (!reactionsOpen(await gd.getHeader(code, { consistent: false }), now)) return { sent: false };
  try {
    await update(T(), gd.keys.member(code, user.id), {
      update: 'SET #lastReactAt = :now',
      condition: 'attribute_exists(#sk) AND (attribute_not_exists(#lastReactAt) OR #lastReactAt < :cut)',
      values: { ':now': now, ':cut': now - REACT_GAP_MS },
    });
  } catch (err) {
    ignoreCheckFailed(err); // too soon after the last one (or not a member): silently dropped
    return { sent: false };
  }
  await update(T(), gd.keys.reactions(code, Math.floor(Math.random() * gd.REACTION_SHARDS)), {
    update: `ADD #e${emoji} :one SET #expiresAt = if_not_exists(#expiresAt, :exp)`,
    values: { ':one': 1, ':exp': playTtl() },
  });
  deferOnce(ctx, `react:${code}`, () => requestReactionPush(code));
  return { sent: true };
}

async function requestReactionPush(code) {
  const now = Date.now();
  const claims = await gd.getClaims(code);
  if (claims?.reactDue && claims.reactDue > now - LOBBY_CLAIM_STALE_MS) return; // a pending push will carry ours
  const due = now + REACT_WINDOW_MS;
  try {
    await update(T(), gd.keys.claims(code), {
      update: 'SET #reactDue = :due, #expiresAt = if_not_exists(#expiresAt, :exp)',
      condition: 'attribute_not_exists(#reactDue) OR #reactDue < :stale',
      values: { ':due': due, ':exp': playTtl(), ':stale': now - LOBBY_CLAIM_STALE_MS },
    });
  } catch (err) {
    ignoreCheckFailed(err);
    return;
  }
  try {
    await scheduleAdvance({ kind: 'reactions', code, due, dueAt: due });
  } catch (err) {
    await update(T(), gd.keys.claims(code), { update: 'REMOVE #reactDue', condition: '#reactDue = :due', values: { ':due': due } }).catch(() => {});
    throw err;
  }
}

async function reactionTimer({ code, due, dueAt }) {
  const wait = (dueAt ?? due) - Date.now();
  if (wait > 0) await sleep(wait);
  try {
    // Release the claim BEFORE collecting: reactions after this point schedule their own push.
    await update(T(), gd.keys.claims(code), { update: 'REMOVE #reactDue', condition: '#reactDue = :due', values: { ':due': due } });
  } catch (err) {
    ignoreCheckFailed(err);
    return;
  }
  const kinds = Array.from({ length: REACTION_KINDS }, (_, i) => `#e${i}`).join(', ');
  const counts = Array.from({ length: REACTION_KINDS }, () => 0);
  // Take and reset each shard's counters in one atomic step (ALL_OLD = what they were).
  await Promise.all(Array.from({ length: gd.REACTION_SHARDS }, async (_, s) => {
    try {
      const res = await update(T(), gd.keys.reactions(code, s), { update: `REMOVE ${kinds}`, condition: 'attribute_exists(#pk)' }, { ReturnValues: 'ALL_OLD' });
      for (let i = 0; i < REACTION_KINDS; i++) counts[i] += Number(res.Attributes?.[`e${i}`] ?? 0);
    } catch (err) {
      ignoreCheckFailed(err); // nobody reacted on this shard
    }
  }));
  if (!counts.some((n) => n > 0)) return;
  const h = await gd.getHeader(code, { consistent: false });
  if (!reactionsOpen(h, Date.now())) return;
  const members = await gd.queryMembers(code, { consistent: false });
  await broadcast(h, members, 'reactions', () => ({ code, v: h.version, counts }));
}

// ---------- timers (GameTimer Lambda) ----------
/** Entry point of the GameTimer Lambda. Every kind is idempotent: duplicates and late deliveries are harmless. */
export async function runTimer(event) {
  const kind = event.kind ?? event.phase; // `phase` = protocol-1 events still queued during a deploy
  if (kind === 'question') return questionTimer(event);
  if (kind === 'reveal') return revealTimer(event);
  if (kind === 'lobby') return lobbyTimer(event);
  if (kind === 'unstick') return unstick(event.code);
  if (kind === 'reactions') return reactionTimer(event);
  if (kind === 'sweep') return sweepGames();
  log('warn', 'unknown timer event', { event });
}

/** Lives for the whole question: pushes answer counts, then closes the question at its deadline. */
async function questionTimer({ code, qIndex: k, dueAt }) {
  let lastCount = 0;
  let header = null;
  let members = null;
  let membersAt = 0;
  while (Date.now() < dueAt) {
    await sleep(Math.min(COUNT_POLL_MS, Math.max(0, dueAt - Date.now())));
    if (Date.now() >= dueAt) break;
    // Cheap eventually consistent poll; a miss is re-checked strongly (a lagging replica must not kill the closer).
    const gate = (await gd.getGate(code, k, { consistent: false })) ?? (await gd.getGate(code, k));
    if (!gate) return;
    if (gate.closedAt) {
      const h = await gd.getHeader(code);
      if (!V.isQuestionAt(h, k)) return; // closed and revealed
      if (Date.now() - gate.closedAt >= TAKEOVER_MS) break; // the closer died: finish its job below
      continue;
    }
    if (gate.answered !== lastCount) {
      header ??= await gd.getHeader(code);
      if (!V.isQuestionAt(header, k)) return;
      if (!members || Date.now() - membersAt > MEMBERS_CACHE_MS) {
        members = await gd.queryMembers(code);
        membersAt = Date.now();
      }
      lastCount = gate.answered;
      await broadcast(header, members, 'answer:count', () => V.answerCount(header, k, gate.answered));
    }
  }
  // The deadline: this timer is the guaranteed closer. If someone else claimed the close and is still working (or
  // died), keep checking until the question is really closed; closeQuestion takes over once their claim is stale.
  const giveUpAt = Date.now() + TAKEOVER_MS + 3000;
  while (!(await closeQuestion(code, k)) && Date.now() < giveUpAt) {
    if (!V.isQuestionAt(await gd.getHeader(code), k)) return;
    await sleep(1000);
  }
}

async function revealTimer({ code, qIndex: k, dueAt }) {
  const wait = dueAt - Date.now();
  if (wait > 0) await sleep(wait);
  return advanceAfterReveal(code, k);
}

async function advanceAfterReveal(code, k) {
  const h = await gd.getHeader(code);
  if (!h) return;
  if (h.status === 'ended' && !h.resultsSaved) return endGame(code);
  if (!V.isRevealAt(h, k)) return;
  if (k + 1 < h.total) await openQuestion(code, k + 1, { header: h });
  else await endGame(code);
}

/** Schedule an un-stick if this game is overdue (its timer was lost). A lease makes 250 watchdogs cost one run. */
async function maybeUnstick(code) {
  const now = Date.now();
  const h = await gd.getHeader(code);
  const lobby = h?.status === 'lobby' ? await gd.getLobby(code) : null;
  if (!V.stuckReason(h, lobby, now)) return;
  try {
    await update(T(), gd.keys.claims(code), {
      update: 'SET #unstickUntil = :until, #expiresAt = if_not_exists(#expiresAt, :exp)',
      condition: 'attribute_not_exists(#unstickUntil) OR #unstickUntil < :now',
      values: { ':until': now + UNSTICK_LEASE_MS, ':now': now, ':exp': playTtl() },
    });
  } catch (err) {
    ignoreCheckFailed(err);
    return;
  }
  log('warn', 'scheduling an un-stick', { code, status: h.status, qIndex: h.qIndex });
  await scheduleAdvance({ kind: 'unstick', code, dueAt: now });
}

async function unstick(code) {
  const h = await gd.getHeader(code);
  if (!h) return;
  const lobby = h.status === 'lobby' ? await gd.getLobby(code) : null;
  const reason = V.stuckReason(h, lobby, Date.now());
  if (reason === 'question') {
    // A closer that died leaves closedAt set; closeQuestion takes over once it is older than TAKEOVER_MS.
    await closeQuestion(code, h.qIndex);
  } else if (reason === 'reveal') {
    await advanceAfterReveal(code, h.qIndex);
  } else if (reason === 'start') {
    try {
      await beginGame(code, h, lobby?.count ?? 0);
    } catch (err) {
      if (!(err instanceof GameError)) throw err;
    }
  } else if (reason === 'end') {
    await endGame(code);
  }
}

// ---------- the sweep: abandoned, expired and frozen games ----------
// Every live game normally moves itself along (timers) and gets cleaned up by whoever is in it. Nothing did that for a
// game everyone walked away from: a lobby stayed "live" until someone came back, and a game whose timer chain broke
// stayed mid-question forever. A scheduled GameTimer event ({kind:'sweep'}, every 2 minutes) closes those.

/** Why this live game should be closed now (the reason players are shown), or null. Pure. */
export function abandonReason(h, { anyoneHere, lastSeenAt, stuck, overdueBy }, now = Date.now()) {
  if (h.status === 'lobby' && now > h.lobbyExpiresAt) return 'The lobby expired.';
  if (now - (Date.parse(h.createdAt) || now) > MAX_GAME_MS) return 'The game ran too long and was closed.';
  if (!anyoneHere) {
    const idleFor = now - lastSeenAt;
    if (h.status === 'lobby' && idleFor >= IDLE_LOBBY_MS) return 'Everyone left the lobby, so it was closed.';
    if (h.status !== 'lobby' && idleFor >= IDLE_PLAYING_MS) return 'Everyone left, so the game was closed.';
  }
  if (stuck && overdueBy > FROZEN_MS) return 'The game stopped responding and was closed.';
  return null;
}

/** How long past its deadline the current phase is (0 if it isn't). */
function overdueBy(h, lobby, now) {
  const due = h.status === 'question' ? (h.acceptUntil ?? h.endsAt)
    : h.status === 'reveal' ? h.revealEndsAt
      : h.status === 'lobby' && lobby?.closedAt ? lobby.closedAt : now;
  return Math.max(0, now - (Number(due) || now));
}

/** Check one live game; cancel it if it was abandoned, or try to un-stick it. True if it was cancelled. */
async function sweepGame(code, now = Date.now()) {
  const h = await gd.getHeader(code);
  if (!V.isLiveStatus(h?.status)) return false;
  const [members, lobby] = await Promise.all([gd.queryMembers(code), h.status === 'lobby' ? gd.getLobby(code) : null]);
  const conns = members.flatMap(V.connIds);
  const anyoneHere = conns.length > 0 && (await anySocketAlive(conns, now));
  // When the last person was here: their last socket closing, or (no socket ever closed) when they joined.
  const lastSeenAt = Math.max(Date.parse(h.createdAt) || 0, ...members.map((m) => Number(m.seenAt ?? m.joinedAt ?? 0)));
  const stuck = V.stuckReason(h, lobby, now);
  const reason = abandonReason(h, { anyoneHere, lastSeenAt, stuck, overdueBy: overdueBy(h, lobby, now) }, now);
  if (reason) {
    const done = await cancel(code, reason);
    if (done) log('info', 'closed an abandoned game', { code, status: h.status, qIndex: h.qIndex, reason });
    return done;
  }
  if (stuck) {
    log('warn', 'sweep un-sticking a game', { code, status: h.status, qIndex: h.qIndex, stuck });
    await unstick(code); // a failure here is retried by the next sweep, and cancelled once FROZEN_MS has passed
  }
  return false;
}

/** The scheduled sweep over every live game. Never throws for one bad game. */
export async function sweepGames(now = Date.now()) {
  const live = await scanAll({
    TableName: env.gamesTable,
    ...gd.expr({ filter: '#status IN (:l, :q, :r)', projection: '#code', values: { ':l': 'lobby', ':q': 'question', ':r': 'reveal' } }),
  });
  let closed = 0;
  for (const { code } of live) {
    try {
      if (await sweepGame(code, now)) closed++;
    } catch (error) {
      log('error', 'sweeping a game failed', { error, code });
    }
  }
  if (closed) metric('GamesAbandoned', closed);
  return { live: live.length, closed };
}

// ---------- admin ----------
export async function gameStats() {
  const games = await scanAll({ TableName: env.gamesTable, ProjectionExpression: 'code, #s, endedAt, lobbyExpiresAt', ExpressionAttributeNames: { '#s': 'status' } });
  const now = Date.now();
  const finished = games.filter((g) => g.status === 'ended');
  const weekAgo = new Date(now - 7 * 864e5).toISOString();
  const perDay = new Map();
  for (const g of finished) {
    if (g.endedAt >= weekAgo) perDay.set(g.endedAt.slice(0, 10), (perDay.get(g.endedAt.slice(0, 10)) || 0) + 1);
  }
  return {
    liveGames: games.filter((g) => V.isLive(g, now)).length,
    gamesPlayed: finished.length,
    gamesPerDay: [...perDay].sort().map(([day, count]) => ({ day, games: count })),
  };
}
