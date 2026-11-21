// The admin panel's reads and account actions (handlers/http.js checks the admin role before calling any of these):
// overview numbers and daily series, the games monitor, user details and moderation, the audit log, rate-limit
// counters, system health and the site announcement.
//
// Reads are mostly full Scans. That is fine for the few thousand items this app keeps, and only admins pay for them;
// at a much larger scale you'd keep running counters (DynamoDB Streams) instead.
//
// AdminTable (HASH pk, RANGE sk):
//   AUDIT   / "<ISO time>#<random>"   one entry per admin action (who, what, which target), kept a year (TTL)
//   SETTING / "announcement"           the banner the play page shows to everyone
import crypto from 'node:crypto';
import { DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import { BatchWriteCommand, DeleteCommand, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { client, ddb, scanAll, queryAll, nowIso, sleep } from './db.js';
import { env } from './config.js';
import { HttpError } from './errors.js';
import { log } from './log.js';
import { listUsers, getUserById, deleteUserRecords } from './users.js';
import { listQuestions, asyncCache } from './questions.js';
import { listQuizzes, listAllQuizzes, quizSummary, adminDeleteQuiz } from './quizzes.js';
import { allResults, aggregate, refreshBoards } from './results.js';
import { connectionsForUser } from './connections.js';
import { kickUser } from './game.js';
import { emailId, fixedWindow, REGISTER_WINDOW_MS, LOGIN_WINDOW_MS } from './ratelimit.js';
import * as gd from './gamedata.js';
import * as V from './views.js';
import * as Q from './qtypes.js';

const DAY_MS = 864e5;
const STARTED_AT = nowIso(); // when this container started (the System page shows it)

// Every attribute aliased: status, count, total, code... are DynamoDB reserved words.
const projection = (fields) => ({
  ProjectionExpression: fields.map((f) => `#${f}`).join(', '),
  ExpressionAttributeNames: Object.fromEntries(fields.map((f) => [`#${f}`, f])),
});

const byNewest = (field) => (a, b) => String(b[field] ?? '').localeCompare(String(a[field] ?? ''));

// ---------- days in the viewer's time zone ----------
/** Calendar day (YYYY-MM-DD) of an ISO time, for a viewer `tzMinutes` east of UTC. Null for a missing time. */
export function dayOf(iso, tzMinutes = 0) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t + tzMinutes * 60_000).toISOString().slice(0, 10) : null;
}

/** The last `days` calendar days (the viewer's), oldest first, today last. */
export function lastDays(days, tzMinutes = 0, now = Date.now()) {
  const today = Date.parse(`${new Date(now + tzMinutes * 60_000).toISOString().slice(0, 10)}T00:00:00Z`);
  return Array.from({ length: days }, (_, i) => new Date(today - (days - 1 - i) * DAY_MS).toISOString().slice(0, 10));
}

// ---------- games ----------
const GAME_FIELDS = ['code', 'status', 'hostId', 'hostName', 'category', 'quizTitle', 'total', 'qIndex', 'playerCount',
  'createdAt', 'endedAt', 'lobbyExpiresAt', 'cancelReason', 'bigScreen', 'doublePoints', 'hostPlays'];

/** lobby | question | reveal | ended | cancelled | expired (a lobby that timed out before anyone started it). */
export function gameState(g, now = Date.now()) {
  if (g.status === 'lobby' && now > g.lobbyExpiresAt) return 'expired';
  return g.status;
}

export const gameRow = (g, now = Date.now()) => ({
  code: g.code,
  state: gameState(g, now),
  live: V.isLive(g, now),
  hostId: g.hostId ?? null,
  hostName: g.hostName ?? null,
  category: g.category ?? null,
  quizTitle: g.quizTitle ?? null,
  total: g.total ?? 0,
  qIndex: g.qIndex ?? -1,
  playerCount: g.playerCount ?? 0,
  createdAt: g.createdAt ?? null,
  endedAt: g.endedAt ?? null,
  cancelReason: g.cancelReason ?? null,
  bigScreen: !!g.bigScreen,
  doublePoints: !!g.doublePoints,
  hostPlays: !!g.hostPlays,
});

const scanGames = () => scanAll({ TableName: env.gamesTable, ...projection(GAME_FIELDS) });
const scanSockets = () => scanAll({ TableName: env.connectionsTable, ...projection(['userId', 'gameCode']) });

/** Every game header still stored (finished games are kept 30 days, cancelled ones a day), newest first. */
export async function listGames() {
  const now = Date.now();
  return (await scanGames()).map((g) => gameRow(g, now)).sort(byNewest('createdAt'));
}

const savedResultsOf = (code) => scanAll({
  TableName: env.resultsTable,
  FilterExpression: '#code = :c',
  ExpressionAttributeNames: { '#code': 'code' },
  ExpressionAttributeValues: { ':c': code },
});

/**
 * One game in full: header, standings (live from the game's own items, or the saved results once those expired after a
 * day), and every question with its answer and how it went. Null if nothing is known about the code.
 */
export async function gameDetail(code) {
  const now = Date.now();
  const h = await gd.getHeader(code);
  const [members, scoresItem, questions, questionResults, saved] = await Promise.all([
    h ? gd.queryMembers(code) : [],
    h ? gd.getScores(code) : null,
    h ? gd.getQuestions(code) : null,
    queryAll({ TableName: env.gamePlayTable, ConsistentRead: true, ...gd.expr({ key: '#pk = :pk', values: { ':pk': `${code}#R` } }) }),
    savedResultsOf(code),
  ]);
  if (!h && !saved.length) return null;

  let players;
  if (members.length) {
    const byUser = new Map(members.map((m) => [m.userId, m]));
    players = V.rankRows(V.rosterOf(members), scoresItem?.scores ?? {}).map((r) => ({
      userId: r.userId, username: r.username, rank: r.rank, score: r.score, correctCount: r.correctCount,
      streak: r.streak ?? 0, bestStreak: r.bestStreak ?? 0,
      online: V.isConnected(byUser.get(r.userId)), joinedAt: byUser.get(r.userId)?.joinedAt ?? null,
    }));
  } else {
    players = saved
      .map((r) => ({ userId: r.userId, username: r.username, rank: r.rank, score: r.score, correctCount: r.correctCount, online: false }))
      .sort((a, b) => a.rank - b.rank || b.score - a.score);
  }

  const resultOf = new Map(questionResults.map((r) => [Number(r.k ?? r.sk), r]));
  const asked = (k) => resultOf.has(k) || (!!h && (h.qIndex > k || (h.qIndex === k && h.status !== 'lobby')));
  const qs = (questions ?? []).map((q, k) => {
    const r = resultOf.get(k);
    return {
      k, type: Q.typeOf(q), text: q.text, category: q.category ?? null, double: !!q.double, timeLimit: q.timeLimit ?? null,
      answer: Q.answerText(q), asked: asked(k), open: h?.status === 'question' && h.qIndex === k,
      answered: r?.answeredCount ?? null, right: r?.rightCount ?? null, players: r?.playerCount ?? null, fastest: r?.fastest ?? null,
    };
  });

  const host = h ? members.find((m) => m.userId === h.hostId) : null;
  const game = h
    ? { ...gameRow(h, now), version: h.version, awards: h.awards ?? null, lobbyExpiresAt: h.lobbyExpiresAt ?? null, archived: false }
    : {
        // The header expired (30 days): what the saved results still say.
        code, state: 'ended', live: false, archived: true, category: saved[0].category ?? null, endedAt: saved[0].endedAt ?? null,
        total: saved[0].questionCount ?? 0, playerCount: saved[0].playerCount ?? saved.length, hostName: null, hostId: null,
      };
  return {
    game,
    players,
    questions: qs,
    online: players.filter((p) => p.online).length,
    hostOnline: host ? V.isConnected(host) : false,
    hostPresenter: !!host?.presenter,
    detailKept: members.length > 0 || questionResults.length > 0,
  };
}

// ---------- overview ----------
/** Dashboard numbers for the last `days` days (in the viewer's time zone), compared with the `days` before them. */
export async function overview({ days = 30, tz = 0 } = {}) {
  const now = Date.now();
  const [users, results, games, sockets, questions, quizzes, recentAudit] = await Promise.all([
    listUsers(), allResults(), scanGames(), scanSockets(), listQuestions({ fresh: true }), listAllQuizzes(),
    listAudit({ limit: 6 }).then((r) => r.entries).catch(() => []),
  ]);

  const range = lastDays(days, tz, now);
  const inRange = new Set(range);
  const before = new Set(lastDays(days * 2, tz, now).slice(0, days));
  const day = new Map(range.map((d) => [d, { day: d, signups: 0, plays: 0, games: new Set(), players: new Set() }]));
  const prev = { signups: 0, plays: 0, games: new Set(), players: new Set() };
  const totals = { signups: 0, plays: 0, games: new Set(), players: new Set() };

  for (const u of users) {
    const d = dayOf(u.createdAt, tz);
    if (inRange.has(d)) {
      day.get(d).signups += 1;
      totals.signups += 1;
    } else if (before.has(d)) prev.signups += 1;
  }
  // A game is its code + end time: codes are reused once an old game's items have expired.
  const gameId = (r) => `${r.code}#${r.endedAt}`;
  for (const r of results) {
    const d = dayOf(r.endedAt, tz);
    const bucket = inRange.has(d) ? day.get(d) : before.has(d) ? prev : null;
    if (!bucket) continue;
    bucket.plays += 1;
    bucket.games.add(gameId(r));
    bucket.players.add(r.userId);
    if (bucket !== prev) {
      totals.plays += 1;
      totals.games.add(gameId(r));
      totals.players.add(r.userId);
    }
  }

  const usersById = new Map(users.map((u) => [u.id, u]));
  const live = games.filter((g) => V.isLive(g, now));
  const countBy = (items, key) => {
    const m = new Map();
    for (const it of items) m.set(key(it), (m.get(key(it)) || 0) + 1);
    return [...m].map(([k, count]) => ({ key: k, count })).sort((a, b) => b.count - a.count || String(a.key).localeCompare(String(b.key)));
  };

  return {
    days,
    generatedAt: nowIso(),
    totals: {
      users: users.length,
      admins: users.filter((u) => u.role === 'admin').length,
      banned: users.filter((u) => u.banned).length,
      newUsers: totals.signups,
      newUsersPrev: prev.signups,
      gamesPlayed: new Set(results.map(gameId)).size,
      games: totals.games.size,
      gamesPrev: prev.games.size,
      plays: totals.plays,
      playsPrev: prev.plays,
      activePlayers: totals.players.size,
      activePlayersPrev: prev.players.size,
      questions: questions.length,
      categories: new Set(questions.map((q) => q.category)).size,
      quizzes: quizzes.length,
      sharedQuizzes: quizzes.filter((q) => q.shared).length,
    },
    now: {
      liveGames: live.length,
      lobbies: live.filter((g) => g.status === 'lobby').length,
      playersInGames: live.reduce((s, g) => s + (g.playerCount || 0), 0),
      onlineUsers: new Set(sockets.map((c) => c.userId)).size,
      sockets: sockets.length,
    },
    series: [...day.values()].map((b) => ({ day: b.day, signups: b.signups, games: b.games.size, plays: b.plays, players: b.players.size })),
    byCategory: countBy(questions, (q) => q.category).map(({ key, count }) => ({ category: key, count })),
    byType: countBy(questions, (q) => Q.typeOf(q)).map(({ key, count }) => ({ type: key, count })),
    topPlayers: aggregate(results)
      .filter((t) => usersById.has(t.userId))
      .sort((a, b) => b.totalScore - a.totalScore || b.wins - a.wins)
      .slice(0, 6)
      .map((t) => ({
        userId: t.userId, username: usersById.get(t.userId).username, banned: !!usersById.get(t.userId).banned,
        totalScore: t.totalScore, games: t.gamesPlayed, wins: t.wins,
      })),
    recentUsers: [...users].sort(byNewest('createdAt')).slice(0, 6)
      .map((u) => ({ id: u.id, username: u.username, role: u.role, banned: !!u.banned, createdAt: u.createdAt })),
    recentGames: games.map((g) => gameRow(g, now)).sort(byNewest('createdAt')).slice(0, 6),
    recentAudit,
  };
}

// ---------- users ----------
const userRow = (u, { totals, lastPlayedAt = null, online = false, quizzes = 0 } = {}) => ({
  id: u.id,
  username: u.username,
  email: u.email,
  role: u.role,
  banned: !!u.banned,
  banReason: u.banReason ?? null,
  createdAt: u.createdAt ?? null,
  lastLoginAt: u.lastLoginAt ?? null,
  currentGame: u.currentGame ?? null,
  gamesPlayed: totals?.gamesPlayed ?? 0,
  wins: totals?.wins ?? 0,
  totalScore: totals?.totalScore ?? 0,
  lastPlayedAt,
  online,
  quizzes,
});

/**
 * Every account with its play totals, whether it is online now, the live game it is in and how many quizzes it owns.
 * Newest first.
 */
export async function userList() {
  const now = Date.now();
  const [users, results, sockets, quizzes, games] = await Promise.all([listUsers(), allResults(), scanSockets(), listAllQuizzes(), scanGames()]);
  // currentGame lingers after a game ends (the player's next visit clears it): only live games count.
  const live = new Set(games.filter((g) => V.isLive(g, now)).map((g) => g.code));
  const totals = new Map(aggregate(results).map((t) => [t.userId, t]));
  const lastPlayed = new Map();
  for (const r of results) if ((lastPlayed.get(r.userId) ?? '') < r.endedAt) lastPlayed.set(r.userId, r.endedAt);
  const online = new Set(sockets.map((c) => c.userId));
  const owned = new Map();
  for (const q of quizzes) owned.set(q.ownerId, (owned.get(q.ownerId) || 0) + 1);
  return users
    .map((u) => ({
      ...userRow(u, { totals: totals.get(u.id), lastPlayedAt: lastPlayed.get(u.id) ?? null, online: online.has(u.id), quizzes: owned.get(u.id) || 0 }),
      currentGame: live.has(u.currentGame) ? u.currentGame : null,
    }))
    .sort(byNewest('createdAt'));
}

const resultRowsOf = async (userId) => queryAll({
  TableName: env.resultsTable,
  KeyConditionExpression: 'userId = :u',
  ExpressionAttributeValues: { ':u': userId },
  ScanIndexForward: false,
  ConsistentRead: true,
});

/** One account in full: profile, play stats, recent games, quizzes, open sockets and the live game it is in. */
export async function userDetail(id) {
  const user = await getUserById(id, { consistent: true });
  if (!user) return null;
  const [rows, quizzes, sockets, current, banner] = await Promise.all([
    resultRowsOf(id),
    listQuizzes(id),
    connectionsForUser(id),
    user.currentGame ? gd.getHeader(user.currentGame) : null,
    user.bannedBy ? getUserById(user.bannedBy) : null,
  ]);
  const sum = (f) => rows.reduce((s, r) => s + (r[f] || 0), 0);
  const totals = aggregate(rows)[0];
  const now = Date.now();
  return {
    user: {
      ...userRow(user, { totals, lastPlayedAt: rows[0]?.endedAt ?? null, online: sockets.length > 0, quizzes: quizzes.length }),
      bannedAt: user.bannedAt ?? null,
      bannedBy: banner ? { id: banner.id, username: banner.username } : null,
      passwordResetAt: user.passwordResetAt ?? null,
      sessionsRevokedAt: user.sessionsRevokedAt ?? null,
    },
    stats: {
      gamesPlayed: rows.length,
      wins: rows.filter((r) => r.rank === 1).length,
      podiums: rows.filter((r) => r.rank <= 3).length,
      totalScore: sum('score'),
      bestScore: rows.reduce((m, r) => Math.max(m, r.score || 0), 0),
      averageRank: rows.length ? Math.round((sum('rank') / rows.length) * 10) / 10 : null,
      correctAnswers: sum('correctCount'),
      questionsSeen: sum('questionCount'),
    },
    games: rows.slice(0, 100).map((r) => ({
      code: r.code, endedAt: r.endedAt, category: r.category ?? null, score: r.score, rank: r.rank,
      playerCount: r.playerCount ?? null, correctCount: r.correctCount ?? 0, questionCount: r.questionCount ?? null,
    })),
    quizzes: quizzes.map(quizSummary),
    sessions: sockets.map((c) => ({ connectedAt: c.connectedAt ?? null, gameCode: c.gameCode ?? null })).sort(byNewest('connectedAt')),
    currentGame: current && V.isLive(current, now) ? gameRow(current, now) : null,
  };
}

/** BatchWrite deletes in chunks of 25, retrying unprocessed keys with backoff. */
async function deleteKeys(table, keys) {
  for (let i = 0; i < keys.length; i += 25) {
    let requests = keys.slice(i, i + 25).map((Key) => ({ DeleteRequest: { Key } }));
    for (let attempt = 0; requests.length; attempt++) {
      if (attempt === 8) throw new HttpError(503, 'Server busy, please try again.');
      if (attempt) await sleep(Math.random() * Math.min(3000, 100 * 2 ** attempt));
      const res = await ddb.send(new BatchWriteCommand({ RequestItems: { [table]: requests } }));
      requests = res.UnprocessedItems?.[table] ?? [];
    }
  }
}

/**
 * Delete an account for good: out of any live game (a game it hosts is cancelled), every socket closed, its quizzes
 * and game results deleted, then the account itself; the leaderboards are recomputed without it.
 */
export async function deleteAccount(id) {
  const user = await getUserById(id, { consistent: true });
  if (!user) throw new HttpError(404, 'User not found');
  await kickUser(id);
  const [quizzes, rows] = await Promise.all([listQuizzes(id), resultRowsOf(id)]);
  await Promise.all(quizzes.map((q) => adminDeleteQuiz(q.id).catch((err) => { if (err.status !== 404) throw err; })));
  await deleteKeys(env.resultsTable, rows.map((r) => ({ userId: r.userId, sk: r.sk })));
  await deleteUserRecords(user);
  await refreshBoards();
  return { user, quizzes: quizzes.length, results: rows.length };
}

// ---------- audit log ----------
const AUDIT_PK = 'AUDIT';
const AUDIT_KEEP_DAYS = 365;

/**
 * Record an admin action: `target` = { type: 'user' | 'question' | 'game' | ..., id, label }. Best effort: the action
 * already happened, so a failed write is logged (CloudWatch keeps it) instead of failing the request.
 */
export async function audit(admin, action, target = {}, details = {}) {
  const at = nowIso();
  const item = {
    pk: AUDIT_PK,
    sk: `${at}#${crypto.randomBytes(4).toString('hex')}`,
    at,
    adminId: admin.id,
    adminName: admin.username,
    action,
    targetType: target.type ?? null,
    targetId: target.id ?? null,
    targetLabel: target.label ?? null,
    details,
    expiresAt: Math.floor(Date.now() / 1000) + AUDIT_KEEP_DAYS * 86400,
  };
  try {
    await ddb.send(new PutCommand({ TableName: env.adminTable, Item: item }));
  } catch (error) {
    log('error', 'Could not write the audit log', { error, action, adminId: admin.id, target });
  }
}

const auditEntry = (i) => ({
  id: i.sk,
  at: i.at,
  admin: { id: i.adminId, username: i.adminName },
  action: i.action,
  target: { type: i.targetType, id: i.targetId, label: i.targetLabel },
  details: i.details ?? {},
});

/** Newest first, `limit` at a time. Pass the previous page's `next` as `before` for the page after it. */
export async function listAudit({ limit = 50, before = null } = {}) {
  const res = await ddb.send(new QueryCommand({
    TableName: env.adminTable,
    KeyConditionExpression: before ? 'pk = :p AND sk < :b' : 'pk = :p',
    ExpressionAttributeValues: { ':p': AUDIT_PK, ...(before ? { ':b': before } : {}) },
    ScanIndexForward: false,
    Limit: limit,
  }));
  const entries = (res.Items ?? []).map(auditEntry);
  return { entries, next: res.LastEvaluatedKey && entries.length ? entries.at(-1).id : null };
}

// ---------- announcement ----------
const ANNOUNCEMENT_KEY = { pk: 'SETTING', sk: 'announcement' };
// Every page load asks for it: cached per container, so a crowd arriving at once costs one read per warm Lambda.
const announcementCache = asyncCache(async () => {
  const res = await ddb.send(new GetCommand({ TableName: env.adminTable, Key: ANNOUNCEMENT_KEY }));
  const a = res.Item;
  return a?.text ? { id: a.id, text: a.text, tone: a.tone ?? 'info', updatedAt: a.updatedAt, updatedBy: a.updatedBy ?? null } : null;
}, 15_000);

/** The banner shown on the play page, or null. Up to 15 s stale unless `fresh`. */
export const getAnnouncement = ({ fresh = false } = {}) => announcementCache.get({ fresh });

export async function setAnnouncement(admin, { text, tone }) {
  const item = { ...ANNOUNCEMENT_KEY, id: crypto.randomBytes(6).toString('hex'), text, tone, updatedAt: nowIso(), updatedBy: admin.username };
  try {
    await ddb.send(new PutCommand({ TableName: env.adminTable, Item: item }));
  } finally {
    announcementCache.invalidate();
  }
  return { id: item.id, text, tone, updatedAt: item.updatedAt, updatedBy: item.updatedBy };
}

export async function clearAnnouncement() {
  try {
    await ddb.send(new DeleteCommand({ TableName: env.adminTable, Key: ANNOUNCEMENT_KEY }));
  } finally {
    announcementCache.invalidate();
  }
}

// ---------- rate limits ----------
const COUNTERS = [
  { kind: 'signup-ip', re: /^reg#(.+)#(\d+)$/, windowMs: REGISTER_WINDOW_MS, limit: () => env.registerMaxPerIp },
  { kind: 'login-ip', re: /^lfail#ip#(.+)#(\d+)$/, windowMs: LOGIN_WINDOW_MS, limit: () => env.loginFailMaxPerIp },
  { kind: 'login-account', re: /^lfail#email#(.+)#(\d+)$/, windowMs: LOGIN_WINDOW_MS, limit: () => env.loginFailMaxPerEmail },
];

/**
 * The sign-up and failed-login counters of the current windows (older windows no longer block anyone). Account
 * counters only hold a hash of the email: matched back to a username where the email belongs to an account.
 */
export async function rateLimitCounters() {
  const now = Date.now();
  const [items, users] = await Promise.all([scanAll({ TableName: env.rateLimitsTable }), listUsers()]);
  const byHash = new Map(users.map((u) => [emailId(u.email), u]));
  const counters = [];
  for (const item of items) {
    for (const c of COUNTERS) {
      const m = c.re.exec(String(item.key));
      if (!m) continue;
      const index = Number(m[2]);
      if (index !== fixedWindow(now, c.windowMs).index) break;
      const account = c.kind === 'login-account' ? byHash.get(m[1]) ?? null : null;
      const hits = Number(item.hits) || 0;
      counters.push({
        key: item.key,
        kind: c.kind,
        subject: c.kind === 'login-account' ? account?.email ?? null : m[1],
        user: account ? { id: account.id, username: account.username } : null,
        hits,
        limit: c.limit(),
        blocked: hits >= c.limit(),
        resetsAt: new Date((index + 1) * c.windowMs).toISOString(),
      });
      break;
    }
  }
  counters.sort((a, b) => Number(b.blocked) - Number(a.blocked) || b.hits / b.limit - a.hits / a.limit);
  return {
    counters,
    limits: { signupsPerIpPerHour: env.registerMaxPerIp, failedLoginsPerIp: env.loginFailMaxPerIp, failedLoginsPerAccount: env.loginFailMaxPerEmail },
  };
}

/** Reset one counter (unblocks that IP or account right away). Returns what it counted, for the audit log. */
export async function clearCounter(key) {
  const c = COUNTERS.find((x) => x.re.test(key));
  if (!c) throw new HttpError(400, 'That is not a rate-limit counter.');
  await ddb.send(new DeleteCommand({ TableName: env.rateLimitsTable, Key: { key } }));
  const subject = c.re.exec(key)[1];
  if (c.kind === 'signup-ip') return `sign-ups from ${subject}`;
  if (c.kind === 'login-ip') return `failed logins from ${subject}`;
  const account = (await listUsers()).find((u) => emailId(u.email) === subject);
  return `failed logins for ${account ? account.username : 'an unknown email'}`;
}

// ---------- system ----------
const TABLES = () => ({
  Users: env.usersTable, Questions: env.questionsTable, Games: env.gamesTable, GamePlay: env.gamePlayTable,
  Connections: env.connectionsTable, Results: env.resultsTable, Quizzes: env.quizzesTable,
  RateLimits: env.rateLimitsTable, Admin: env.adminTable,
});

/** Health, runtime and configuration of the backend, and the size of every table. */
export async function systemInfo() {
  const started = performance.now();
  await ddb.send(new GetCommand({ TableName: env.usersTable, Key: { pk: '#health' } }));
  const dbLatencyMs = Math.round(performance.now() - started);

  const [tables, sockets, games] = await Promise.all([
    Promise.all(Object.entries(TABLES()).map(async ([label, name]) => {
      try {
        const { Table: t } = await client.send(new DescribeTableCommand({ TableName: name }));
        return {
          label, name, status: t.TableStatus, items: t.ItemCount ?? 0, bytes: t.TableSizeBytes ?? 0,
          indexes: (t.GlobalSecondaryIndexes ?? []).map((i) => i.IndexName),
          billing: t.BillingModeSummary?.BillingMode ?? 'PROVISIONED',
        };
      } catch (error) {
        log('warn', 'DescribeTable failed', { table: name, error });
        return { label, name, status: 'UNAVAILABLE', items: null, bytes: null, indexes: [], billing: null };
      }
    })),
    scanSockets(),
    scanGames(),
  ]);
  const now = Date.now();
  return {
    checkedAt: nowIso(),
    health: { api: 'ok', database: 'ok', dbLatencyMs },
    runtime: {
      region: process.env.AWS_REGION || null,
      functionName: process.env.AWS_LAMBDA_FUNCTION_NAME || 'local dev server',
      memoryMb: Number(process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE) || null,
      node: process.version,
      local: !!process.env.QUIBBLE_LOCAL,
      containerStartedAt: STARTED_AT,
      protocol: V.PROTOCOL,
    },
    config: {
      maxPlayers: env.maxPlayers,
      lateGraceMs: env.lateGraceMs,
      revealMs: env.revealMs,
      broadcastWindowMs: env.broadcastWindowMs,
      registerMaxPerIp: env.registerMaxPerIp,
      loginFailMaxPerIp: env.loginFailMaxPerIp,
      loginFailMaxPerEmail: env.loginFailMaxPerEmail,
    },
    tables,
    live: {
      sockets: sockets.length,
      onlineUsers: new Set(sockets.map((c) => c.userId)).size,
      liveGames: games.filter((g) => V.isLive(g, now)).length,
    },
  };
}
