// The game state machine (lobby -> question -> reveal -> ... -> ended), serverless edition.
//
// Every live game is ONE item in the Games table. Many Lambdas may touch the same game at once
// (50 players answering in the same second, the timer firing, someone disconnecting), so every
// change goes through mutateGame(): read the item, apply a pure change in memory, then write it
// back only if its `version` is unchanged ("optimistic locking"). On a conflict we re-read and
// retry. This keeps the server authoritative without any long-running process.
//
// Deadlines: whoever moves the game into a new phase also schedules the GameTimer Lambda for that
// phase's deadline. If everyone answers early, the question closes immediately and the timer that
// wakes up later sees the phase already moved on and does nothing.
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, scanAll, isConditionFailed, nowIso, sleep } from './db.js';
import { env } from './config.js';
import { GameError } from './errors.js';
import { calculateScore, rankPlayers } from './scoring.js';
import { pickRandom } from './questions.js';
import { getUserById, setCurrentGame, clearCurrentGame } from './users.js';
import { attachUserToGame, detachUserFromGame, detachAllFromGame, connectionsForUser, getConnection, deleteConnectionRecord } from './connections.js';
import { emitToGame, sendEvent, disconnectUser } from './push.js';
import { scheduleAdvance } from './timer.js';
import { saveResults } from './results.js';
import { log, metric } from './log.js';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I to avoid typos
const GRACE_MS = 400; // network slack after the timer ends
const LOBBY_TTL_MS = 30 * 60 * 1000;
const STUCK_MS = 8000; // if a timer was lost, any visitor un-sticks the game after this
const MAX_PLAYERS = 50;
const KEEP_FINISHED_DAYS = 30; // DynamoDB TTL removes old game items after this
const LIVE = new Set(['lobby', 'question', 'reveal']);
const NOOP = Symbol('noop');

// ---------- reading ----------
async function getGame(code) {
  const res = await ddb.send(new GetCommand({ TableName: env.gamesTable, Key: { code }, ConsistentRead: true }));
  return res.Item || null;
}

const isLive = (g, now = Date.now()) =>
  !!g && LIVE.has(g.status) && !(g.status === 'lobby' && now > g.lobbyExpiresAt);

const players = (g) => Object.values(g.players || {}).sort((a, b) => a.joinedAt - b.joinedAt);

/** The live game this user belongs to (as host or player), or null. */
async function gameOfUser(userId) {
  const user = await getUserById(userId);
  if (!user?.currentGame) return null;
  const g = await getGame(user.currentGame);
  if (isLive(g) && (g.hostId === userId || g.players?.[userId])) return g;
  return null;
}

// ---------- views sent to clients (never include correct answers before the reveal) ----------
const playerList = (g) => players(g).map((p) => ({ userId: p.userId, username: p.username, score: p.score, connected: p.connected }));

const leaderboard = (g) =>
  rankPlayers(players(g)).map((p) => ({
    userId: p.userId, username: p.username, score: p.score, correctCount: p.correctCount, lastGain: p.lastGain, rank: p.rank,
  }));

const state = (g) => ({
  code: g.code,
  status: g.status,
  hostId: g.hostId,
  hostName: g.hostName,
  hostPlays: !!g.hostPlays,
  category: g.category ?? null,
  total: g.questions.length,
  players: playerList(g),
});

const publicQuestion = (g) => {
  const q = g.questions[g.qIndex];
  return {
    index: g.qIndex, total: g.questions.length, text: q.text, options: q.options,
    timeLimit: q.timeLimit, endsAt: g.endsAt, serverNow: Date.now(),
  };
};

const answerCount = (g) => {
  const all = players(g);
  return { answered: all.filter((p) => p.current).length, total: all.length };
};

function snapshot(g, userId) {
  const snap = state(g);
  if (g.status === 'question') {
    snap.question = publicQuestion(g);
    snap.answered = !!g.players?.[userId]?.current;
    snap.answerCount = answerCount(g);
  }
  if (g.status === 'reveal') snap.result = g.lastResult;
  return snap;
}

// ---------- writing ----------
/**
 * Read-modify-write with optimistic locking. `change(game)` mutates the game in memory and returns
 * a value (or NOOP to skip the write). It may run several times, so it must not have side effects.
 */
async function mutateGame(code, change) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const g = await getGame(code);
    if (!g) throw new GameError('No game with that code.');
    const out = change(g);
    if (out === NOOP) return { game: g, out, changed: false };
    const prev = g.version;
    g.version = prev + 1;
    try {
      await ddb.send(new PutCommand({
        TableName: env.gamesTable,
        Item: g,
        ConditionExpression: 'version = :v',
        ExpressionAttributeValues: { ':v': prev },
      }));
      return { game: g, out, changed: true };
    } catch (err) {
      if (!isConditionFailed(err)) throw err;
      metric('GameWriteConflicts');
      await sleep(10 + Math.random() * 30 * (attempt + 1));
    }
  }
  throw new GameError('The game is busy, please try again.');
}

// ---------- pure state transitions (run inside mutateGame) ----------
function openNextQuestion(g, now) {
  g.qIndex += 1;
  if (g.qIndex >= g.questions.length) {
    g.status = 'ended';
    g.endedAt = new Date(now).toISOString();
    g.expiresAt = Math.floor(now / 1000) + KEEP_FINISHED_DAYS * 86400;
    return 'ended';
  }
  const q = g.questions[g.qIndex];
  for (const p of Object.values(g.players)) {
    p.current = null;
    p.lastGain = 0;
  }
  g.status = 'question';
  g.questionStartedAt = now;
  g.endsAt = now + q.timeLimit * 1000;
  g.lastResult = null;
  return 'question';
}

function closeQuestion(g, now) {
  const q = g.questions[g.qIndex];
  for (const p of Object.values(g.players)) {
    if (p.current) {
      p.score += p.current.gained;
      p.lastGain = p.current.gained;
      if (p.current.correct) p.correctCount += 1;
    } else {
      p.lastGain = 0;
    }
  }
  g.status = 'reveal';
  g.revealEndsAt = now + env.revealMs;
  g.lastResult = {
    index: g.qIndex,
    total: g.questions.length,
    text: q.text,
    options: q.options,
    correctIndex: q.correctIndex,
    leaderboard: leaderboard(g),
    choices: players(g).map((p) => ({
      userId: p.userId,
      choice: p.current ? p.current.choice : null,
      correct: p.current ? p.current.correct : false,
    })),
  };
  return 'reveal';
}

function cancelState(g, reason, now) {
  g.status = 'cancelled';
  g.cancelReason = reason;
  g.endedAt = new Date(now).toISOString();
  g.expiresAt = Math.floor(now / 1000) + 86400;
  return 'cancelled';
}

/** Everyone still connected has answered -> don't wait for the timer.
 *  If nobody is connected we let the timer run, so people have a chance to reconnect. */
function everyoneAnswered(g) {
  if (g.status !== 'question') return false;
  const active = players(g).filter((p) => p.connected);
  return active.length > 0 && active.every((p) => p.current);
}

/** A game whose timer got lost (very rare) is moved on by whoever looks at it next. */
function unstick(g, now) {
  if (g.status === 'lobby' && now > g.lobbyExpiresAt) return cancelState(g, 'The lobby expired.', now);
  if (g.status === 'question' && now > g.endsAt + STUCK_MS) return closeQuestion(g, now);
  if (g.status === 'reveal' && now > g.revealEndsAt + STUCK_MS) return openNextQuestion(g, now);
  return NOOP;
}

// ---------- side effects after a transition was committed ----------
async function afterTransition(g, kind) {
  if (kind === 'question') {
    metric('QuestionsAsked');
    await emitToGame(g.code, 'question:show', publicQuestion(g));
    await emitToGame(g.code, 'room:state', state(g));
    await scheduleAdvance({ code: g.code, qIndex: g.qIndex, phase: 'question', dueAt: g.endsAt + GRACE_MS });
  } else if (kind === 'reveal') {
    await emitToGame(g.code, 'question:result', g.lastResult);
    await emitToGame(g.code, 'room:state', state(g));
    await scheduleAdvance({ code: g.code, qIndex: g.qIndex, phase: 'reveal', dueAt: g.revealEndsAt });
  } else if (kind === 'ended') {
    const board = leaderboard(g);
    try {
      await saveResults(g, board);
    } catch (err) {
      log('error', 'Failed to save game results', { code: g.code, error: err });
    }
    metric('GamesFinished');
    await emitToGame(g.code, 'game:end', { code: g.code, leaderboard: board });
    await dispose(g);
  } else if (kind === 'cancelled') {
    metric('GamesCancelled');
    await emitToGame(g.code, 'game:cancelled', { reason: g.cancelReason });
    await dispose(g);
  }
}

async function dispose(g) {
  const ids = new Set([g.hostId, ...Object.keys(g.players || {})]);
  await Promise.all([...ids].map((id) => clearCurrentGame(id, g.code)));
  await detachAllFromGame(g.code);
}

// ---------- public operations (called from the WebSocket / HTTP / timer handlers) ----------
export async function create(user, { category, count, hostPlays = false }) {
  if (await gameOfUser(user.id)) throw new GameError("You're already in a game. Leave it first.");
  const questions = await pickRandom(category, count);
  if (!questions.length) throw new GameError('There are no questions for that category yet.');

  const now = Date.now();
  const g = {
    code: '',
    version: 1,
    status: 'lobby',
    hostId: user.id,
    hostName: user.username,
    hostPlays: !!hostPlays,
    category: category ?? null,
    questions,
    qIndex: -1,
    questionStartedAt: 0,
    endsAt: 0,
    revealEndsAt: 0,
    lastResult: null,
    createdAt: nowIso(),
    lobbyExpiresAt: now + LOBBY_TTL_MS,
    expiresAt: Math.floor(now / 1000) + KEEP_FINISHED_DAYS * 86400,
    players: {},
  };
  if (hostPlays) g.players[user.id] = newPlayer(user, now);

  for (let attempt = 0; ; attempt++) {
    g.code = Array.from({ length: 6 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
    try {
      await ddb.send(new PutCommand({ TableName: env.gamesTable, Item: g, ConditionExpression: 'attribute_not_exists(code)' }));
      break;
    } catch (err) {
      if (!isConditionFailed(err) || attempt > 5) throw err;
    }
  }
  await setCurrentGame(user.id, g.code);
  await attachUserToGame(user.id, g.code);
  metric('GamesCreated');
  await emitToGame(g.code, 'room:state', state(g));
  return { code: g.code, snapshot: snapshot(g, user.id) };
}

const newPlayer = (user, now) => ({
  userId: user.id, username: user.username, score: 0, correctCount: 0, lastGain: 0,
  connected: true, current: null, joinedAt: now,
});

export async function join(user, { code }) {
  code = code.toUpperCase();
  const existing = await gameOfUser(user.id);
  if (existing && existing.code !== code) throw new GameError("You're already in another game.");

  const { game, changed } = await mutateGame(code, (g) => {
    const now = Date.now();
    if (!isLive(g, now)) throw new GameError('No game with that code.');
    let p = g.players[user.id];
    if (g.hostId === user.id && !p) return NOOP; // presenter-only host reopening the room
    if (!p) {
      if (g.status !== 'lobby') throw new GameError('That game has already started.');
      if (Object.keys(g.players).length >= MAX_PLAYERS) throw new GameError('That game is full.');
      p = g.players[user.id] = newPlayer(user, now);
    } else if (p.connected) {
      return NOOP;
    }
    p.connected = true;
  });
  await setCurrentGame(user.id, code);
  await attachUserToGame(user.id, code);
  if (changed) await emitToGame(code, 'room:state', state(game));
  return { code, snapshot: snapshot(game, user.id) };
}

/** Sent by the browser every time its socket (re)opens: put returning users back into their game. */
export async function hello(user, connectionId) {
  const g = await gameOfUser(user.id);
  if (!g) {
    // An expired lobby is no longer "live" but its item still says lobby: cancel it so the
    // other people sitting in it are told, and their currentGame pointers are cleared.
    const code = (await getUserById(user.id))?.currentGame;
    const stale = code && (await getGame(code));
    if (stale?.status === 'lobby') await cancel(code, 'The lobby expired.');
    return { inGame: false };
  }
  // If the deadline timer got lost, move the game along now.
  const healed = await mutateGame(g.code, (x) => unstick(x, Date.now()));
  if (healed.changed) {
    await afterTransition(healed.game, healed.out);
    if (!isLive(healed.game)) return { inGame: false };
  }
  await attachUserToGame(user.id, g.code);
  const { game, changed } = await mutateGame(g.code, (x) => {
    const p = x.players[user.id];
    if (!isLive(x) || !p || p.connected) return NOOP;
    p.connected = true;
  });
  if (changed) await emitToGame(game.code, 'room:state', state(game));
  await sendEvent(connectionId, 'room:rejoined', snapshot(game, user.id));
  return { inGame: true };
}

export async function leave(user) {
  const g = await gameOfUser(user.id);
  if (!g) return {};
  if (g.status !== 'lobby') throw new GameError("You can't leave a game that's in progress.");
  if (g.hostId === user.id) return cancel(g.code, 'The host left the game.');
  const { game, changed } = await mutateGame(g.code, (x) => {
    if (!x.players[user.id]) return NOOP;
    delete x.players[user.id];
  });
  await clearCurrentGame(user.id, g.code);
  await detachUserFromGame(user.id, g.code);
  if (changed) await emitToGame(g.code, 'room:state', state(game));
  return {};
}

export async function start(user) {
  const g = await gameOfUser(user.id);
  if (!g || g.hostId !== user.id) throw new GameError('Only the host can start the game.');
  const { game, out } = await mutateGame(g.code, (x) => {
    if (x.status !== 'lobby') throw new GameError('The game has already started.');
    if (Object.keys(x.players).length < 1) throw new GameError('Wait for at least one player to join.');
    x.startedAt = nowIso();
    return openNextQuestion(x, Date.now());
  });
  metric('GamesStarted');
  await afterTransition(game, out);
  return {};
}

export async function cancelByHost(user) {
  const g = await gameOfUser(user.id);
  if (!g) throw new GameError('No game found.');
  if (g.hostId !== user.id) throw new GameError('Only the host can cancel the game.');
  return cancel(g.code, 'The host cancelled the game.');
}

async function cancel(code, reason) {
  const { game, out, changed } = await mutateGame(code, (x) => (LIVE.has(x.status) ? cancelState(x, reason, Date.now()) : NOOP));
  if (changed) await afterTransition(game, out);
  return {};
}

export async function submitAnswer(user, { choice }) {
  const g = await gameOfUser(user.id);
  if (!g?.players?.[user.id]) throw new GameError("You're not playing in a game.");
  const qIndex = g.qIndex;

  const { game, out } = await mutateGame(g.code, (x) => {
    const p = x.players[user.id];
    if (!p) throw new GameError("You're not playing in a game.");
    if (x.status !== 'question' || x.qIndex !== qIndex) throw new GameError('No question is open right now.');
    if (p.current) throw new GameError('You already answered.');
    const q = x.questions[x.qIndex];
    if (choice >= q.options.length) throw new GameError('Invalid option.');
    const now = Date.now();
    if (now > x.endsAt + GRACE_MS) throw new GameError('Too late!');

    // The SERVER measures time and decides correctness. The client only says "I picked #choice".
    const elapsedMs = now - x.questionStartedAt;
    const correct = choice === q.correctIndex;
    const gained = calculateScore({ correct, elapsedMs, timeLimitMs: q.timeLimit * 1000 });
    p.current = { choice, correct, gained, elapsedMs };
    return everyoneAnswered(x) ? closeQuestion(x, now) : 'answered';
  });

  metric('AnswersSubmitted');
  if (out === 'reveal') await afterTransition(game, out);
  else await emitToGame(game.code, 'answer:count', answerCount(game));
  return { locked: true };
}

/** $disconnect: mark the player offline if this was their last tab. */
export async function disconnect(connectionId) {
  const conn = await getConnection(connectionId);
  await deleteConnectionRecord(connectionId);
  if (!conn?.gameCode) return;
  const others = (await connectionsForUser(conn.userId)).filter((c) => c.gameCode === conn.gameCode && c.connectionId !== connectionId);
  if (others.length) return; // they still have another tab open

  let result;
  try {
    result = await mutateGame(conn.gameCode, (x) => {
      const p = x.players?.[conn.userId];
      if (!isLive(x) || !p || !p.connected) return NOOP;
      p.connected = false;
      // If the missing player was the last one we were waiting on, move on.
      return everyoneAnswered(x) ? closeQuestion(x, Date.now()) : 'offline';
    });
  } catch (err) {
    if (err instanceof GameError) return; // game is gone
    throw err;
  }
  if (!result.changed) return;
  if (result.out === 'reveal') await afterTransition(result.game, 'reveal');
  else await emitToGame(result.game.code, 'room:state', state(result.game));
}

/** Admin banned someone: remove them from their live game and close their sockets. */
export async function kickUser(userId) {
  const g = await gameOfUser(userId);
  if (g) {
    if (g.hostId === userId) await cancel(g.code, 'The host was removed.');
    else {
      const { game, out, changed } = await mutateGame(g.code, (x) => {
        if (!x.players[userId]) return NOOP;
        delete x.players[userId];
        return everyoneAnswered(x) ? closeQuestion(x, Date.now()) : 'removed';
      });
      await clearCurrentGame(userId, g.code);
      if (changed) {
        if (out === 'reveal') await afterTransition(game, out);
        else await emitToGame(game.code, 'room:state', state(game));
      }
    }
  }
  await disconnectUser(userId);
}

/** Called by the GameTimer Lambda when a phase's deadline is reached. Safe to call twice. */
export async function advance({ code, qIndex, phase }) {
  let result;
  try {
    result = await mutateGame(code, (x) => {
      if (x.qIndex !== qIndex) return NOOP;
      if (phase === 'question' && x.status === 'question') return closeQuestion(x, Date.now());
      if (phase === 'reveal' && x.status === 'reveal') return openNextQuestion(x, Date.now());
      return NOOP;
    });
  } catch (err) {
    if (err instanceof GameError) return; // game no longer exists
    throw err;
  }
  if (result.changed) await afterTransition(result.game, result.out);
}

/** Is the phase a timer is waiting on still the current one? (Lets the timer exit early.) */
export async function phaseStillOpen({ code, qIndex, phase }) {
  const g = await getGame(code);
  return !!g && g.qIndex === qIndex && g.status === phase;
}

/** Admin stats. */
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
    liveGames: games.filter((g) => isLive(g, now)).length,
    gamesPlayed: finished.length,
    gamesPerDay: [...perDay].sort().map(([day, games]) => ({ day, games })),
  };
}
