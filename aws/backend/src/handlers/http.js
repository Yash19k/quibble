// REST API: API Gateway HTTP API -> this Lambda (payload format 2.0).
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { requireAuth, requireAdmin, signToken } from '../lib/auth.js';
import {
  createUser, getUserByEmail, getUserById, listUsers, publicUser, updateUser, touchLogin, renameUser, revokeSessions,
} from '../lib/users.js';
import {
  categories, createQuestion, deleteQuestion, deleteMany, insertMany, listQuestions, mapQuestion, renameCategory, typeCounts,
  updateQuestion,
} from '../lib/questions.js';
import {
  adminDeleteQuiz, createQuiz, deleteQuiz, getQuiz, listAllQuizzes, listQuizzes, quizFull, quizSummary, setShared, updateQuiz,
} from '../lib/quizzes.js';
import { leaderboard, history, aggregate, allResults, refreshBoards } from '../lib/results.js';
import { forceCancel, gameStats, kickUser } from '../lib/game.js';
import { disconnectUser } from '../lib/push.js';
import * as admin from '../lib/admin.js';
import { fetchTriviaQuestions, OPENTDB_CATEGORIES } from '../lib/trivia.js';
import { limitRegister, assertLoginAllowed, recordLoginFailure } from '../lib/ratelimit.js';
import { HttpError } from '../lib/errors.js';
import {
  parse, registerSchema, loginSchema, questionSchema, quizSchema, userPatchSchema, triviaImportSchema, idListSchema,
  questionImportSchema, categoryRenameSchema, quizPatchSchema, gameEndSchema, announcementSchema,
} from '../lib/schemas.js';
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

/** A game code from the URL: 6 letters or digits, upper-cased. */
function gameCodeParam(raw) {
  const code = String(raw).trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code)) throw new HttpError(400, 'Invalid game code');
  return code;
}

const questionTarget = (q) => ({ type: 'question', id: q.id, label: q.text ? q.text.slice(0, 80) : q.id });

/** The account an admin action targets: never the admin themself (400), and it must exist (404). */
async function otherUser(me, id, selfMessage) {
  if (id === me.id) throw new HttpError(400, selfMessage);
  const user = await getUserById(id, { consistent: true });
  if (!user) throw new HttpError(404, 'User not found');
  return user;
}

// ---------- routes ----------
const routes = [
  // The monitor function calls this every minute: an answer means API Gateway, this Lambda and DynamoDB all work.
  ['GET', '/api/health', async () => {
    await admin.pingDatabase();
    return { ok: true, db: 'ok' };
  }],

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
    // Only feeds the admin panel's "last login": never worth failing a login over.
    await touchLogin(user.id).catch((error) => log('warn', 'Could not record the login time', { error }));
    return { user: publicUser(user), token: signToken(user.id, user.sessionVersion) };
  }],

  // Tokens are stateless: logging out = the browser forgets its token.
  ['POST', '/api/auth/logout', async () => ({ ok: true })],

  ['GET', '/api/auth/me', async ({ event }) => ({ user: await requireAuth(event) })],

  ['GET', '/api/categories', async () => {
    const [cats, types] = await Promise.all([categories(), typeCounts()]);
    return { categories: cats, types };
  }],

  // ---------- My quizzes (any signed-in player) ----------
  ['GET', '/api/quizzes', async ({ event }) => {
    const user = await requireAuth(event);
    return { quizzes: (await listQuizzes(user.id)).map(quizSummary) };
  }],

  ['POST', '/api/quizzes', async ({ event, body }) => {
    const user = await requireAuth(event);
    return [201, { quiz: quizFull(await createQuiz(user, parse(quizSchema, body))) }];
  }],

  // The owner gets everything; anyone else only the summary of a shared quiz (enough to host it, never the answers).
  ['GET', '/api/quizzes/:id', async ({ event, params }) => {
    const user = await requireAuth(event);
    const quiz = await getQuiz(params.id);
    if (quiz && quiz.ownerId === user.id) return { quiz: quizFull(quiz), mine: true };
    if (quiz?.shared) return { quiz: quizSummary(quiz), mine: false };
    throw new HttpError(404, "That quiz doesn't exist or isn't shared.");
  }],

  ['PUT', '/api/quizzes/:id', async ({ event, body, params }) => {
    const user = await requireAuth(event);
    return { quiz: quizFull(await updateQuiz(user, params.id, parse(quizSchema, body))) };
  }],

  ['DELETE', '/api/quizzes/:id', async ({ event, params }) => {
    const user = await requireAuth(event);
    await deleteQuiz(user, params.id);
    return { ok: true };
  }],

  ['GET', '/api/leaderboard', async ({ query }) => {
    const period = query.period === 'week' ? 'week' : 'all';
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 20, 1), 100);
    return { period, leaderboard: await leaderboard(period, limit) };
  }],

  ['GET', '/api/me/history', async ({ event }) => history((await requireAuth(event)).id)],

  // The banner admins post (maintenance, events). Public: the play page shows it before anyone logs in.
  ['GET', '/api/announcement', async () => ({ announcement: await admin.getAnnouncement() })],

  // ---------- admin ----------
  // Every admin route checks the role first. Actions that change something are written to the audit log
  // (admin.audit), which the panel's Activity page lists. Question reads skip the per-container cache: the panel
  // reloads right after an edit.

  ['GET', '/api/admin/overview', async ({ event, query }) => {
    await requireAdmin(event);
    const days = [7, 14, 30, 90].includes(Number(query.days)) ? Number(query.days) : 30;
    const tz = Math.max(-840, Math.min(840, Math.trunc(Number(query.tz) || 0))); // the viewer's UTC offset (minutes)
    return admin.overview({ days, tz });
  }],

  // ----- games -----
  ['GET', '/api/admin/games', async ({ event }) => {
    await requireAdmin(event);
    return { games: (await admin.listGames()).slice(0, 2000) };
  }],

  ['GET', '/api/admin/games/:code', async ({ event, params }) => {
    await requireAdmin(event);
    const detail = await admin.gameDetail(gameCodeParam(params.code));
    if (!detail) throw new HttpError(404, 'No game with that code.');
    return detail;
  }],

  ['POST', '/api/admin/games/:code/end', async ({ event, body, params }) => {
    const me = await requireAdmin(event);
    const code = gameCodeParam(params.code);
    const { reason } = parse(gameEndSchema, body);
    const ended = await forceCancel(code, reason);
    if (ended) await admin.audit(me, 'game.end', { type: 'game', id: code, label: code }, reason ? { reason } : {});
    return { ok: true, ended };
  }],

  // ----- questions -----
  ['GET', '/api/admin/questions', async ({ event, query }) => {
    await requireAdmin(event);
    const q = String(query.q || '').trim().toLowerCase();
    const category = String(query.category || '');
    const type = String(query.type || '');
    const questions = (await listQuestions({ fresh: true }))
      .filter((x) => (!q || x.text.toLowerCase().includes(q)) && (!category || x.category === category) && (!type || (x.type || 'choice') === type))
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
      .slice(0, 5000)
      .map(mapQuestion);
    return { questions };
  }],

  ['POST', '/api/admin/questions', async ({ event, body }) => {
    const me = await requireAdmin(event);
    const question = await createQuestion(parse(questionSchema, body), me.id);
    await admin.audit(me, 'question.create', questionTarget(question));
    return [201, { question }];
  }],

  ['PUT', '/api/admin/questions/:id', async ({ event, body, params }) => {
    const me = await requireAdmin(event);
    const question = await updateQuestion(params.id, parse(questionSchema, body));
    await admin.audit(me, 'question.update', questionTarget(question));
    return { question };
  }],

  ['DELETE', '/api/admin/questions/:id', async ({ event, params }) => {
    const me = await requireAdmin(event);
    const before = (await listQuestions({ fresh: true })).find((x) => x.id === params.id);
    await deleteQuestion(params.id);
    await admin.audit(me, 'question.delete', questionTarget(before ?? { id: params.id }));
    return { ok: true };
  }],

  ['POST', '/api/admin/questions/bulk-delete', async ({ event, body }) => {
    const me = await requireAdmin(event);
    const { ids } = parse(idListSchema, body);
    const deleted = await deleteMany(ids);
    await admin.audit(me, 'question.bulkDelete', { type: 'question', label: `${deleted} questions` }, { count: deleted });
    return { ok: true, deleted };
  }],

  // A JSON export (or a hand-made list) back into the bank. All or nothing: the first invalid question stops it.
  ['POST', '/api/admin/questions/import', async ({ event, body }) => {
    const me = await requireAdmin(event);
    const { questions } = parse(questionImportSchema, body);
    const valid = questions.map((q, i) => {
      try {
        return parse(questionSchema, q);
      } catch (err) {
        throw new HttpError(400, `Question ${i + 1}: ${err.message}`);
      }
    });
    const imported = await insertMany(valid, me.id);
    await admin.audit(me, 'question.import', { type: 'question', label: `${imported} questions` }, { imported, skipped: valid.length - imported });
    return { ok: true, imported, skipped: valid.length - imported };
  }],

  ['POST', '/api/admin/categories/rename', async ({ event, body }) => {
    const me = await requireAdmin(event);
    const { from, to } = parse(categoryRenameSchema, body);
    const moved = await renameCategory(from, to);
    if (!moved) throw new HttpError(404, `No questions in "${from}".`);
    await admin.audit(me, 'category.rename', { type: 'category', id: to, label: `${from} → ${to}` }, { from, to, moved });
    return { ok: true, moved };
  }],

  ['GET', '/api/admin/trivia/categories', async ({ event }) => {
    await requireAdmin(event);
    return { categories: OPENTDB_CATEGORIES };
  }],

  ['POST', '/api/admin/trivia/import', async ({ event, body }) => {
    const me = await requireAdmin(event);
    const opts = parse(triviaImportSchema, body);
    let questions;
    try {
      questions = await fetchTriviaQuestions(opts);
    } catch (err) {
      log('warn', 'Trivia import failed', { error: err });
      throw new HttpError(502, err.message || 'Failed to import from OpenTDB.');
    }
    const imported = await insertMany(questions, me.id);
    await admin.audit(me, 'question.importTrivia', { type: 'question', label: `${imported} questions` }, { imported, fetched: questions.length });
    return { ok: true, imported, totalFetched: questions.length };
  }],

  // ----- users -----
  ['GET', '/api/admin/users', async ({ event, query }) => {
    await requireAdmin(event);
    const q = String(query.q || '').trim().toLowerCase();
    const users = (await admin.userList())
      .filter((u) => !q || u.username.toLowerCase().includes(q) || u.email.toLowerCase().includes(q))
      .slice(0, 5000);
    return { users };
  }],

  ['GET', '/api/admin/users/:id', async ({ event, params }) => {
    await requireAdmin(event);
    const detail = await admin.userDetail(params.id);
    if (!detail) throw new HttpError(404, 'User not found');
    return detail;
  }],

  ['PATCH', '/api/admin/users/:id', async ({ event, body, params }) => {
    const me = await requireAdmin(event);
    const patch = parse(userPatchSchema, body);
    if (params.id === me.id && (patch.role !== undefined || patch.banned !== undefined)) {
      throw new HttpError(400, "You can't change your own role or ban yourself");
    }
    let user = await getUserById(params.id, { consistent: true });
    if (!user) throw new HttpError(404, 'User not found');
    const target = { type: 'user', id: user.id, label: user.username };

    if (patch.username !== undefined && patch.username !== user.username) {
      user = await renameUser(params.id, patch.username);
      await admin.audit(me, 'user.rename', { ...target, label: user.username }, { from: target.label, to: user.username });
      await refreshBoards(); // boards show current names
    }
    if (patch.role !== undefined || patch.banned !== undefined) {
      const wasBanned = !!user.banned;
      user = await updateUser(params.id, { role: patch.role, banned: patch.banned, banReason: patch.banReason, bannedBy: me.id });
      if (patch.banned) await kickUser(params.id); // drop them from any live game / socket right away
      // Boards hide banned players: take them off now (or put them back after an unban). Safe to repeat on a retry.
      if (patch.banned !== undefined) await refreshBoards();
      if (patch.role !== undefined) await admin.audit(me, 'user.role', target, { role: patch.role });
      if (patch.banned !== undefined && patch.banned !== wasBanned) {
        await admin.audit(me, patch.banned ? 'user.ban' : 'user.unban', target, patch.banned && patch.banReason ? { reason: patch.banReason } : {});
      }
    }
    return { user: { ...publicUser(user), banned: !!user.banned } };
  }],

  // Out of their current game (not banned: they may join again) and every socket closed.
  ['POST', '/api/admin/users/:id/kick', async ({ event, params }) => {
    const me = await requireAdmin(event);
    const user = await otherUser(me, params.id, "You can't kick yourself.");
    const code = user.currentGame ?? null;
    await kickUser(user.id);
    await admin.audit(me, 'user.kick', { type: 'user', id: user.id, label: user.username }, code ? { game: code } : {});
    return { ok: true, game: code };
  }],

  ['POST', '/api/admin/users/:id/signout', async ({ event, params }) => {
    const me = await requireAdmin(event);
    const user = await otherUser(me, params.id, 'Use Log out to sign yourself out.');
    await revokeSessions(user.id);
    await disconnectUser(user.id);
    await admin.audit(me, 'user.signout', { type: 'user', id: user.id, label: user.username });
    return { ok: true };
  }],

  // A temporary password the admin passes on (there is no email). Every existing session ends.
  ['POST', '/api/admin/users/:id/reset-password', async ({ event, params }) => {
    const me = await requireAdmin(event);
    const user = await otherUser(me, params.id, "You can't reset your own password here.");
    const password = crypto.randomBytes(9).toString('base64url'); // 12 characters
    await revokeSessions(user.id, { passwordHash: await bcrypt.hash(password, BCRYPT_COST) });
    await disconnectUser(user.id);
    await admin.audit(me, 'user.resetPassword', { type: 'user', id: user.id, label: user.username });
    return { ok: true, password };
  }],

  ['DELETE', '/api/admin/users/:id', async ({ event, params }) => {
    const me = await requireAdmin(event);
    await otherUser(me, params.id, "You can't delete your own account.");
    const { user, quizzes, results } = await admin.deleteAccount(params.id);
    await admin.audit(me, 'user.delete', { type: 'user', id: user.id, label: user.username }, { email: user.email, quizzes, results });
    return { ok: true, quizzes, results };
  }],

  // ----- player quizzes -----
  ['GET', '/api/admin/quizzes', async ({ event }) => {
    await requireAdmin(event);
    return { quizzes: (await listAllQuizzes()).map(quizSummary).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))) };
  }],

  ['GET', '/api/admin/quizzes/:id', async ({ event, params }) => {
    await requireAdmin(event);
    const quiz = await getQuiz(params.id);
    if (!quiz) throw new HttpError(404, 'Quiz not found');
    return { quiz: quizFull(quiz) };
  }],

  ['PATCH', '/api/admin/quizzes/:id', async ({ event, body, params }) => {
    const me = await requireAdmin(event);
    const { shared } = parse(quizPatchSchema, body);
    const quiz = await setShared(params.id, shared);
    await admin.audit(me, shared ? 'quiz.share' : 'quiz.unshare', { type: 'quiz', id: quiz.id, label: quiz.title }, { owner: quiz.ownerName });
    return { quiz: quizSummary(quiz) };
  }],

  ['DELETE', '/api/admin/quizzes/:id', async ({ event, params }) => {
    const me = await requireAdmin(event);
    const quiz = await adminDeleteQuiz(params.id);
    await admin.audit(me, 'quiz.delete', { type: 'quiz', id: quiz.id, label: quiz.title }, { owner: quiz.ownerName });
    return { ok: true };
  }],

  // ----- leaderboards -----
  ['GET', '/api/admin/leaderboard', async ({ event, query }) => {
    await requireAdmin(event);
    const period = query.period === 'week' ? 'week' : 'all';
    return { period, leaderboard: await leaderboard(period, 100) };
  }],

  ['POST', '/api/admin/leaderboard/refresh', async ({ event }) => {
    const me = await requireAdmin(event);
    const boards = await refreshBoards();
    await admin.audit(me, 'leaderboard.refresh', { type: 'leaderboard', label: 'All time + this week' });
    return { ok: true, players: boards.all.length };
  }],

  // ----- announcement -----
  ['GET', '/api/admin/announcement', async ({ event }) => {
    await requireAdmin(event);
    return { announcement: await admin.getAnnouncement({ fresh: true }) };
  }],

  ['PUT', '/api/admin/announcement', async ({ event, body }) => {
    const me = await requireAdmin(event);
    const announcement = await admin.setAnnouncement(me, parse(announcementSchema, body));
    await admin.audit(me, 'announcement.set', { type: 'announcement', label: announcement.text.slice(0, 60) }, { tone: announcement.tone });
    return { announcement };
  }],

  ['DELETE', '/api/admin/announcement', async ({ event }) => {
    const me = await requireAdmin(event);
    await admin.clearAnnouncement();
    await admin.audit(me, 'announcement.clear', { type: 'announcement' });
    return { ok: true };
  }],

  // ----- activity, security, system -----
  ['GET', '/api/admin/audit', async ({ event, query }) => {
    await requireAdmin(event);
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 50, 1), 200);
    const before = typeof query.before === 'string' && query.before.length <= 80 ? query.before : null;
    return admin.listAudit({ limit, before });
  }],

  ['GET', '/api/admin/ratelimits', async ({ event }) => {
    await requireAdmin(event);
    return admin.rateLimitCounters();
  }],

  ['DELETE', '/api/admin/ratelimits/:key', async ({ event, params }) => {
    const me = await requireAdmin(event);
    const label = await admin.clearCounter(params.key);
    await admin.audit(me, 'ratelimit.clear', { type: 'ratelimit', id: params.key, label });
    return { ok: true };
  }],

  ['GET', '/api/admin/system', async ({ event }) => {
    await requireAdmin(event);
    return admin.systemInfo();
  }],

  // The panel's first version (kept for scripts and tests): totals, last week's games, top players.
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
  // CORS preflight: the catch-all ANY route sends OPTIONS here. Answer 204; API Gateway adds the configured CORS
  // headers. (A 405 here makes browsers block every cross-origin call, e.g. sign-up from the S3 website.)
  if (method === 'OPTIONS') return { statusCode: 204, headers: { 'cache-control': 'no-store' }, body: '' };
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
