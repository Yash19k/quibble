// Results table: one item per (player, finished game).
//   userId (PK), sk = "<endedAt ISO>#<code>" (SK, so a user's history comes back newest-first)
// History is a Query. Leaderboards are a Scan + aggregate, which is fine for a hobby-sized game;
// at real scale you'd maintain running totals with DynamoDB Streams instead.
import { BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, scanAll, queryAll } from './db.js';
import { env } from './config.js';
import { listUsers } from './users.js';

export async function saveResults(game, board) {
  const endedAt = game.endedAt;
  const items = board.map((p) => ({
    userId: p.userId,
    sk: `${endedAt}#${game.code}`,
    code: game.code,
    username: p.username,
    category: game.category ?? null,
    endedAt,
    score: p.score,
    rank: p.rank,
    correctCount: p.correctCount,
    questionCount: game.questions.length,
    playerCount: board.length,
  }));
  for (let i = 0; i < items.length; i += 25) {
    let requests = items.slice(i, i + 25).map((Item) => ({ PutRequest: { Item } }));
    for (let attempt = 0; requests.length && attempt < 5; attempt++) {
      const res = await ddb.send(new BatchWriteCommand({ RequestItems: { [env.resultsTable]: requests } }));
      requests = res.UnprocessedItems?.[env.resultsTable] || [];
    }
  }
}

const allResults = (sinceIso) =>
  scanAll({
    TableName: env.resultsTable,
    ...(sinceIso
      ? { FilterExpression: 'endedAt >= :s', ExpressionAttributeValues: { ':s': sinceIso } }
      : {}),
  });

/** Totals per user from a list of result rows. */
export function aggregate(rows) {
  const by = new Map();
  for (const r of rows) {
    const t = by.get(r.userId) || { userId: r.userId, username: r.username, totalScore: 0, gamesPlayed: 0, wins: 0, correctAnswers: 0 };
    t.totalScore += r.score;
    t.gamesPlayed += 1;
    t.wins += r.rank === 1 ? 1 : 0;
    t.correctAnswers += r.correctCount;
    by.set(r.userId, t);
  }
  return [...by.values()];
}

export async function leaderboard(period, limit) {
  const since = period === 'week' ? new Date(Date.now() - 7 * 864e5).toISOString() : null;
  const [rows, users] = await Promise.all([allResults(since), listUsers()]);
  const byId = new Map(users.map((u) => [u.id, u]));
  return aggregate(rows)
    .filter((t) => byId.has(t.userId) && !byId.get(t.userId).banned)
    .map((t) => ({ ...t, username: byId.get(t.userId).username }))
    .sort((a, b) => b.totalScore - a.totalScore || b.wins - a.wins || a.username.localeCompare(b.username))
    .slice(0, limit)
    .map(({ userId, ...t }, i) => ({ rank: i + 1, ...t }));
}

export async function history(userId) {
  const rows = await queryAll({
    TableName: env.resultsTable,
    KeyConditionExpression: 'userId = :u',
    ExpressionAttributeValues: { ':u': userId },
    ScanIndexForward: false,
  });
  const totals = {
    totalScore: rows.reduce((s, r) => s + r.score, 0),
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

export { allResults };
