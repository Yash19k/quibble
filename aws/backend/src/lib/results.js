// Results table (HASH userId, RANGE sk). Kinds of items:
//   <userId> / "<endedAt ISO>#<code>"  one per player per finished game (history is a Query, newest first)
//   "#board" / "all" | "week"          materialised leaderboards: { rows (top 100), computedAt (ms) }
//   "#board" / "lease"                 { refreshing (ms) }: who may recompute a missing or stale board
// The boards are recomputed from one Scan when a game ends or a ban changes them, not on every page view, so a crowd
// opening the leaderboard after a game reads one item. (At much larger scale you'd keep running totals with
// DynamoDB Streams instead of scanning.)
import { BatchWriteCommand, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, scanAll, queryAll, isConditionFailed, sleep } from './db.js';
import { env } from './config.js';
import { log } from './log.js';

export const BOARD_ID = '#board';
const BOARD_SIZE = 100;
const WEEK_MS = 7 * 864e5;
// A stored board older than this is recomputed on read. 'week' must drop games older than 7 days as time passes;
// 'all' only changes when results do (refreshBoards), the hour is a safety net in case a refresh was lost.
const MAX_AGE_MS = { week: 10 * 60 * 1000, all: 60 * 60 * 1000 };
// The lease lives on its own tiny item: a failed conditional write is billed at the item's size, so claiming on the
// ~10 KB board item would cost ~10 WCU per reader when a crowd finds the board stale at the same moment.
const LEASE_KEY = { userId: BOARD_ID, sk: 'lease' };
const LEASE_MS = 30 * 1000;
const BATCH_ATTEMPTS = 8;

const isResultRow = (r) => r.userId !== BOARD_ID;

// ---------- saving ----------
async function putChunk(table, items) {
  let requests = items.map((Item) => ({ PutRequest: { Item } }));
  for (let attempt = 0; requests.length; attempt++) {
    if (attempt === BATCH_ATTEMPTS) throw new Error(`${requests.length} result rows stayed unprocessed`);
    if (attempt) await sleep(Math.random() * Math.min(3000, 100 * 2 ** attempt)); // full-jitter backoff
    const res = await ddb.send(new BatchWriteCommand({ RequestItems: { [table]: requests } }));
    requests = res.UnprocessedItems?.[table] ?? [];
  }
}

/** BatchWrite in parallel chunks of 25, retrying unprocessed items. Throws once every chunk has settled if any failed. */
async function batchPutAll(table, items) {
  const chunks = [];
  for (let i = 0; i < items.length; i += 25) chunks.push(items.slice(i, i + 25));
  const failed = (await Promise.allSettled(chunks.map((c) => putChunk(table, c)))).find((o) => o.status === 'rejected');
  if (failed) throw failed.reason;
}

/**
 * One row per player of a finished game. `game` needs code, endedAt, category and total (or questions); `board` is
 * the ranked final board. Idempotent: the sort key comes from the game's deterministic endedAt, so a retry overwrites.
 */
export async function saveResults(game, board) {
  const { code, endedAt } = game;
  if (!code || !endedAt) throw new Error('saveResults needs game.code and game.endedAt');
  const players = [...new Map(board.map((p) => [p.userId, p])).values()]; // BatchWrite rejects duplicate keys
  const items = players.map((p) => ({
    userId: p.userId,
    sk: `${endedAt}#${code}`,
    code,
    username: p.username,
    category: game.category ?? null,
    endedAt,
    score: p.score,
    rank: p.rank,
    correctCount: p.correctCount,
    questionCount: game.total ?? game.questions?.length ?? null,
    playerCount: players.length,
  }));
  await batchPutAll(env.resultsTable, items);
}

// ---------- reading ----------
async function scanResults({ sinceIso = null, consistent = false } = {}) {
  const rows = await scanAll({
    TableName: env.resultsTable,
    ConsistentRead: consistent,
    ...(sinceIso ? { FilterExpression: 'endedAt >= :s', ExpressionAttributeValues: { ':s': sinceIso } } : {}),
  });
  return rows.filter(isResultRow);
}

/** Every result row (optionally only games that ended at/after `sinceIso`), never the stored boards. */
export const allResults = (sinceIso) => scanResults({ sinceIso });

/** Totals per user from a list of result rows. */
export function aggregate(rows) {
  const by = new Map();
  for (const r of rows) {
    const t = by.get(r.userId) || { userId: r.userId, username: r.username, totalScore: 0, gamesPlayed: 0, wins: 0, correctAnswers: 0 };
    t.totalScore += r.score || 0;
    t.gamesPlayed += 1;
    t.wins += r.rank === 1 ? 1 : 0;
    t.correctAnswers += r.correctCount || 0;
    by.set(r.userId, t);
  }
  return [...by.values()];
}

/**
 * Leaderboard rows from result rows: totals per player without banned or deleted accounts, with current usernames,
 * best first (points, then wins, then name), rank = position. Rows: {rank, username, totalScore, gamesPlayed, wins,
 * correctAnswers}. `usersById`: Map of id -> {username, banned}.
 */
export function buildBoard(results, usersById, { sinceIso = null, limit = BOARD_SIZE } = {}) {
  const rows = results.filter((r) => isResultRow(r) && (!sinceIso || r.endedAt >= sinceIso));
  return aggregate(rows)
    .flatMap((t) => {
      const user = usersById.get(t.userId);
      return user && !user.banned ? [{ ...t, username: user.username }] : [];
    })
    .sort((a, b) => b.totalScore - a.totalScore || b.wins - a.wins || String(a.username).localeCompare(String(b.username)))
    .slice(0, limit)
    .map(({ userId, ...t }, i) => ({ rank: i + 1, ...t }));
}

// Current names and ban flags (users.js's listUsers reads every attribute and is never consistent).
async function boardUsers({ consistent }) {
  const users = await scanAll({
    TableName: env.usersTable,
    ConsistentRead: consistent,
    FilterExpression: '#t = :u',
    ProjectionExpression: '#id, #n, #b',
    ExpressionAttributeNames: { '#t': 'type', '#id': 'id', '#n': 'username', '#b': 'banned' },
    ExpressionAttributeValues: { ':u': 'user' },
  });
  return new Map(users.map((u) => [u.id, u]));
}

// Consistent by default: endGame refreshes right after saveResults and the admin panel right after a ban, and the
// stored boards must already include those changes.
async function computeBoards(asOf, { consistent = true } = {}) {
  const [rows, users] = await Promise.all([scanResults({ consistent }), boardUsers({ consistent })]);
  const weekStart = new Date(asOf - WEEK_MS).toISOString();
  return { all: buildBoard(rows, users), week: buildBoard(rows, users, { sinceIso: weekStart }) };
}

// `asOf` = when the scan started. The condition stops a slower, older computation from overwriting a newer board.
async function putBoard(period, rows, asOf) {
  try {
    await ddb.send(new PutCommand({
      TableName: env.resultsTable,
      Item: { userId: BOARD_ID, sk: period, rows, computedAt: asOf },
      ConditionExpression: 'attribute_not_exists(computedAt) OR computedAt < :asOf',
      ExpressionAttributeValues: { ':asOf': asOf },
    }));
  } catch (err) {
    if (!isConditionFailed(err)) throw err;
  }
}

const storeBoards = (boards, asOf) =>
  Promise.all(Object.entries(boards).map(([period, rows]) => putBoard(period, rows, asOf)));

/** Recompute both boards from one Scan and store them. Called when a game ends and after an admin (un)bans someone. */
export async function refreshBoards() {
  const asOf = Date.now();
  const boards = await computeBoards(asOf);
  await storeBoards(boards, asOf);
  return boards;
}

async function getBoard(period) {
  const res = await ddb.send(new GetCommand({ TableName: env.resultsTable, Key: { userId: BOARD_ID, sk: period } }));
  return res.Item ?? null;
}

/** True if this caller may recompute the boards for the next LEASE_MS. */
async function claimRefresh(now) {
  try {
    await ddb.send(new UpdateCommand({
      TableName: env.resultsTable,
      Key: LEASE_KEY,
      UpdateExpression: 'SET refreshing = :until',
      ConditionExpression: 'attribute_not_exists(refreshing) OR refreshing < :now',
      ExpressionAttributeValues: { ':until': now + LEASE_MS, ':now': now },
    }));
    return true;
  } catch (err) {
    // Lost the race (or throttled / not allowed): this request serves what is stored and someone else refreshes.
    if (!isConditionFailed(err)) log('warn', 'Could not claim the leaderboard refresh', { error: err });
    return false;
  }
}

// DynamoDB doesn't keep the key order of maps: rebuild rows so the JSON is the same on every path.
const top = (rows, limit) =>
  rows.slice(0, limit).map((r) => ({
    rank: r.rank, username: r.username, totalScore: r.totalScore, gamesPlayed: r.gamesPlayed, wins: r.wins, correctAnswers: r.correctAnswers,
  }));

/** Top `limit` (<= 100) players for period 'all' or 'week': [{rank, username, totalScore, gamesPlayed, wins, correctAnswers}]. */
export async function leaderboard(period, limit) {
  period = period === 'week' ? 'week' : 'all';
  const board = await getBoard(period);
  if (board?.rows && Date.now() - board.computedAt < MAX_AGE_MS[period]) return top(board.rows, limit);

  // Missing or stale: one caller recomputes under a lease while everyone else keeps serving the old board.
  if (await claimRefresh(Date.now())) {
    const asOf = Date.now();
    let boards = null;
    try {
      boards = await computeBoards(asOf);
    } catch (err) {
      if (!board?.rows) throw err;
      log('warn', 'Leaderboard refresh failed, serving the previous board', { period, error: err });
    }
    if (boards) {
      // Storing only spares later readers a recompute, so failing to store must not fail this request.
      await storeBoards(boards, asOf).catch((error) => log('warn', 'Could not store the leaderboards', { error }));
      return top(boards[period], limit);
    }
  }
  if (board?.rows) return top(board.rows, limit);
  // Nothing stored yet and another caller holds the lease: compute without storing (eventual reads cost half).
  return top((await computeBoards(Date.now(), { consistent: false }))[period], limit);
}

export async function history(userId) {
  const rows = (await queryAll({
    TableName: env.resultsTable,
    KeyConditionExpression: 'userId = :u',
    ExpressionAttributeValues: { ':u': userId },
    ScanIndexForward: false,
    ConsistentRead: true, // the game that just ended must already be listed
  })).filter(isResultRow);
  const totals = {
    totalScore: rows.reduce((s, r) => s + (r.score || 0), 0),
    gamesPlayed: rows.length,
    wins: rows.filter((r) => r.rank === 1).length,
  };
  const games = rows.slice(0, 50).map((r) => ({
    code: r.code,
    category: r.category,
    endedAt: r.endedAt,
    score: r.score,
    rank: r.rank,
    correctCount: r.correctCount,
    questionCount: r.questionCount,
    playerCount: r.playerCount,
  }));
  return { totals, games };
}
