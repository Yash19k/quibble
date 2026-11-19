// REST API: API Gateway HTTP API -> this Lambda (payload format 2.0).
import bcrypt from 'bcryptjs';
import { requireAuth, requireAdmin, signToken } from '../lib/auth.js';
import { createUser, getUserByEmail, listUsers, publicUser, updateUser } from '../lib/users.js';
import { categories, createQuestion, deleteQuestion, insertMany, listQuestions, mapQuestion, updateQuestion } from '../lib/questions.js';
import { leaderboard, history, aggregate, allResults, refreshBoards } from '../lib/results.js';
import { gameStats, kickUser } from '../lib/game.js';
import { fetchTriviaQuestions, OPENTDB_CATEGORIES } from '../lib/trivia.js';
import { limitRegister, assertLoginAllowed, recordLoginFailure } from '../lib/ratelimit.js';
import { HttpError } from '../lib/errors.js';
import { parse, registerSchema, loginSchema, questionSchema, userPatchSchema, triviaImportSchema } from '../lib/schemas.js';
import { log, metric } from '../lib/log.js';

const MAX_BODY = 50 * 1024;
const BCRYPT_COST = 10;

// Compared against when the email doesn't exist, so response time doesn't reveal which emails are registered.
let dummyHash;
const getDummyHash = () => (dummyHash ??= bcrypt.hashSync('not-a-real-password', BCRYPT_COST));

const json = (statusCode, body, headers = {}) => ({
  statusCode,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  body: JSON.stringify(body),
});

function readBody(event) {
  if (!event.body) return {};
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  if (raw.length > MAX_BODY) throw new HttpError(413, 'Request too large');
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

const sourceIp = (event) => event.requestContext?.http?.sourceIp || 'unknown';

// ---------- routes ----------
const routes = [
  ['GET', '/api/health', async () => ({ ok: true })],

  ['POST', '/api/auth/register', async ({ event, body }) => {
    const { email, username, password } = parse(registerSchema, body); // a typo doesn't use up the IP's sign-ups
    await limitRegister(sourceIp(event));
    // A taken email/username -> 409 {error, field}; the page then tries logging in (the first attempt may have worked).
    const user = await createUser({ email, username, passwordHash: await bcrypt.hash(password, BCRYPT_COST) });
    metric('UsersRegistered');
    return [201, { user: publicUser(user), token: signToken(user.id) }];
  }],

  ['POST', '/api/auth/login', async ({ event, body }) => {
    const { email, password } = parse(loginSchema, body);
    const ip = sourceIp(event);
    // The limit is checked before the (CPU-heavy) bcrypt compare. Consistent read: the account may be seconds old.
    const [, user] = await Promise.all([assertLoginAllowed(ip, email), getUserByEmail(email, { consistent: true })]);
    const ok = await bcrypt.compare(password, user ? user.passwordHash : getDummyHash());
    if (!user || !ok) {
      // Best effort: failing to count a failure must not turn "wrong password" into a server error.
      await recordLoginFailure(ip, email).catch((error) => log('warn', 'Could not record a failed login', { error }));
      throw new HttpError(401, 'Invalid email or password');
    }
    if (user.banned) throw new HttpError(403, 'This account has been banned');
    return { user: publicUser(user), token: signToken(user.id) };
  }],

  // Tokens are stateless: logging out = the browser forgets its token.
  ['POST', '/api/auth/logout', async () => ({ ok: true })],

  ['GET', '/api/auth/me', async ({ event }) => ({ user: await requireAuth(event) })],

  ['GET', '/api/categories', async () => ({ categories: await categories() })],

  ['GET', '/api/leaderboard', async ({ query }) => {
    const period = query.period === 'week' ? 'week' : 'all';
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 20, 1), 100);
    return { period, leaderboard: await leaderboard(period, limit) };
  }],

  ['GET', '/api/me/history', async ({ event }) => history((await requireAuth(event)).id)],

  // ---------- admin (fresh question reads: the question cache is per container and the panel reloads after edits) ----------
  ['GET', '/api/admin/questions', async ({ event, query }) => {
    await requireAdmin(event);
    const q = String(query.q || '').trim().toLowerCase();
    const category = String(query.category || '');
    const questions = (await listQuestions({ fresh: true }))
      .filter((x) => (!q || x.text.toLowerCase().includes(q)) && (!category || x.category === category))
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
      .slice(0, 500)
      .map(mapQuestion);
    return { questions };
  }],

  ['POST', '/api/admin/questions', async ({ event, body }) => {
    const admin = await requireAdmin(event);
    return [201, { question: await createQuestion(parse(questionSchema, body), admin.id) }];
  }],

  ['PUT', '/api/admin/questions/:id', async ({ event, body, params }) => {
    await requireAdmin(event);
    return { question: await updateQuestion(params.id, parse(questionSchema, body)) };
  }],

  ['DELETE', '/api/admin/questions/:id', async ({ event, params }) => {
    await requireAdmin(event);
    await deleteQuestion(params.id);
    return { ok: true };
  }],

  ['GET', '/api/admin/trivia/categories', async ({ event }) => {
    await requireAdmin(event);
    return { categories: OPENTDB_CATEGORIES };
  }],

  ['POST', '/api/admin/trivia/import', async ({ event, body }) => {
    const admin = await requireAdmin(event);
    const opts = parse(triviaImportSchema, body);
    let questions;
    try {
      questions = await fetchTriviaQuestions(opts);
    } catch (err) {
      log('warn', 'Trivia import failed', { error: err });
      throw new HttpError(502, err.message || 'Failed to import from OpenTDB.');
    }
    const imported = await insertMany(questions, admin.id);
    return { ok: true, imported, totalFetched: questions.length };
  }],

  ['GET', '/api/admin/users', async ({ event, query }) => {
    await requireAdmin(event);
    const q = String(query.q || '').trim().toLowerCase();
    const [users, rows] = await Promise.all([listUsers(), allResults()]);
    const games = new Map(aggregate(rows).map((t) => [t.userId, t.gamesPlayed]));
    return {
      users: users
        .filter((u) => !q || u.username.toLowerCase().includes(q) || u.email.toLowerCase().includes(q))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 200)
        .map((u) => ({ ...publicUser(u), banned: !!u.banned, createdAt: u.createdAt, gamesPlayed: games.get(u.id) || 0 })),
    };
  }],

  ['PATCH', '/api/admin/users/:id', async ({ event, body, params }) => {
    const admin = await requireAdmin(event);
    if (params.id === admin.id) throw new HttpError(400, "You can't change your own role or ban yourself");
    const patch = parse(userPatchSchema, body);
    const user = await updateUser(params.id, patch);
    if (patch.banned) await kickUser(params.id); // drop them from any live game / socket right away
    // Boards hide banned players: take them off now (or put them back after an unban). Safe to repeat on a retry.
    if (patch.banned !== undefined) await refreshBoards();
    return { user: { ...publicUser(user), banned: !!user.banned } };
  }],

  ['GET', '/api/admin/stats', async ({ event }) => {
    await requireAdmin(event);
    const [users, questions, rows, games] = await Promise.all([listUsers(), listQuestions({ fresh: true }), allResults(), gameStats()]);
    const byCat = new Map();
    for (const q of questions) byCat.set(q.category, (byCat.get(q.category) || 0) + 1);
    return {
      totals: {
        users: users.length,
        questions: questions.length,
        gamesPlayed: games.gamesPlayed,
        bannedUsers: users.filter((u) => u.banned).length,
      },
      liveGames: games.liveGames,
      gamesPerDay: games.gamesPerDay,
      topPlayers: aggregate(rows)
        .sort((a, b) => b.totalScore - a.totalScore)
        .slice(0, 5)
        .map((t) => ({ username: t.username, totalScore: t.totalScore, games: t.gamesPlayed })),
      byCategory: [...byCat].map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count),
    };
  }],
];

// Compile "/api/admin/users/:id" into a regex once.
const compiled = routes.map(([method, path, fn]) => {
  const names = [];
  const re = new RegExp(`^${path.replace(/:([a-z]+)/g, (_, n) => { names.push(n); return '([^/]+)'; })}$`);
  return { method, re, names, fn };
});

// ---------- errors ----------
// AWS throttling / outages that outlasted the SDK's own retries. They answer 503, which the page (public/js/net.js)
// retries with backoff, instead of a 500 it would show as a failure.
const TRANSIENT_NAMES = new Set([
  'ThrottlingException', 'ProvisionedThroughputExceededException', 'RequestLimitExceeded', 'TooManyRequestsException',
  'TransactionConflictException', 'InternalServerError', 'ServiceUnavailable', 'TimeoutError',
]);
const TRANSIENT_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNREFUSED', 'EAI_AGAIN']);
const isTransient = (err) =>
  TRANSIENT_NAMES.has(err?.name) || TRANSIENT_CODES.has(err?.code) || err?.$fault === 'server' || !!err?.$retryable;

function errorResponse(err, { method, path, event }) {
  if (err instanceof HttpError) {
    if (err.status === 503) log('warn', 'API busy', { method, path, error: err });
    // `extra` fields (e.g. 409 `field`, 429 `retryAfter`) go into the body next to `error`.
    const retryAfter = err.extra?.retryAfter;
    return json(err.status, { error: err.message, ...err.extra }, retryAfter ? { 'retry-after': String(retryAfter) } : {});
  }
  if (err.validation) return json(400, { error: err.message });
  if (err instanceof URIError) return json(400, { error: 'Invalid URL' }); // malformed %-escape in a path parameter
  if (isTransient(err)) {
    log('warn', 'API busy (AWS throttling or outage)', { method, path, error: err });
    return json(503, { error: 'Server busy, please try again.' });
  }
  // Never leak stack traces to clients; they go to CloudWatch Logs instead.
  log('error', 'Unhandled API error', { method, path, error: err, requestId: event.requestContext?.requestId });
  return json(500, { error: 'Internal server error' });
}

export const handler = async (event) => {
  const method = event.requestContext?.http?.method || 'GET';
  const path = event.rawPath || '/';
  const started = Date.now();
  try {
    let pathMatched = false;
    for (const r of compiled) {
      const m = path.match(r.re);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const params = Object.fromEntries(r.names.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
      const body = ['POST', 'PUT', 'PATCH'].includes(method) ? readBody(event) : {};
      const result = await r.fn({ event, body, params, query: event.queryStringParameters || {} });
      const [status, payload] = Array.isArray(result) ? result : [200, result];
      return json(status, payload);
    }
    return pathMatched ? json(405, { error: 'Method not allowed' }) : json(404, { error: 'Not found' });
  } catch (err) {
    return errorResponse(err, { method, path, event });
  } finally {
    if (Date.now() - started > 3000) log('warn', 'Slow request', { method, path, ms: Date.now() - started });
  }
};
