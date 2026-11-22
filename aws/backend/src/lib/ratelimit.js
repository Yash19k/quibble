// Per-client abuse protection: fixed-window counters in the RateLimits table (TTL on expiresAt).
// API Gateway stage throttling protects the APIs as a whole; these limits are per IP / per account, sized (config.js)
// so a whole classroom behind one Wi-Fi IP can sign up and log in at the same time.
import crypto from 'node:crypto';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, isConditionFailed } from './db.js';
import { env } from './config.js';
import { HttpError } from './errors.js';

export const REGISTER_WINDOW_MS = 60 * 60 * 1000;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;

/** The fixed window `now` falls in: its index, when it ends (ms) and the whole seconds left until then. */
export function fixedWindow(now, windowMs) {
  const index = Math.floor(now / windowMs);
  const endsAt = (index + 1) * windowMs;
  return { index, endsAt, retryAfter: Math.max(1, Math.ceil((endsAt - now) / 1000)) };
}

// Hashed so the table never holds the addresses people typed (typos of other people's emails included).
export const emailId = (email) =>
  crypto.createHash('sha256').update(String(email).trim().toLowerCase()).digest('base64url').slice(0, 24);

/** Keys of the failed-login counters (per IP and per account) for the window `now` falls in. */
export function loginFailureKeys(ip, email, now = Date.now()) {
  const { index } = fixedWindow(now, LOGIN_WINDOW_MS);
  return { ip: `lfail#ip#${ip}#${index}`, email: `lfail#email#${emailId(email)}#${index}` };
}

// TTL is in seconds. A minute of slack so a counter never vanishes while its window is still open.
const expiresAtFor = (endsAt) => Math.floor(endsAt / 1000) + 60;

/** Count a sign-up from `ip`; 429 once env.registerMaxPerIp sign-ups came from it within the current hour. */
export async function limitRegister(ip) {
  const w = fixedWindow(Date.now(), REGISTER_WINDOW_MS);
  try {
    // The condition caps the counter, so a rejected attempt doesn't push the count any higher.
    await ddb.send(new UpdateCommand({
      TableName: env.rateLimitsTable,
      Key: { key: `reg#${ip}#${w.index}` },
      UpdateExpression: 'ADD hits :one SET expiresAt = :exp',
      ConditionExpression: 'attribute_not_exists(hits) OR hits < :max',
      ExpressionAttributeValues: { ':one': 1, ':max': env.registerMaxPerIp, ':exp': expiresAtFor(w.endsAt) },
    }));
  } catch (err) {
    if (!isConditionFailed(err)) throw err;
    throw new HttpError(429, 'Too many sign-ups from this network. Please try again later.', { retryAfter: w.retryAfter });
  }
}

/** +1 on a counter, only while it is below `max`. False when the counter is already at the limit. */
async function bumpBelow(key, max, exp) {
  try {
    await ddb.send(new UpdateCommand({
      TableName: env.rateLimitsTable,
      Key: { key },
      UpdateExpression: 'ADD hits :one SET expiresAt = :exp',
      ConditionExpression: 'attribute_not_exists(hits) OR hits < :max',
      ExpressionAttributeValues: { ':one': 1, ':max': max, ':exp': exp },
    }));
    return true;
  } catch (err) {
    if (isConditionFailed(err)) return false;
    throw err;
  }
}

const unbump = (key) => ddb.send(new UpdateCommand({
  TableName: env.rateLimitsTable,
  Key: { key },
  UpdateExpression: 'ADD hits :neg',
  ConditionExpression: 'attribute_exists(hits) AND hits > :zero',
  ExpressionAttributeValues: { ':neg': -1, ':zero': 0 },
})).catch(() => {}); // best effort: at worst one success stays counted until the window ends

/**
 * Take one login attempt from the IP's and the account's budgets BEFORE the password is checked. Each counter is
 * bumped atomically and only while it is under its limit, so a burst of parallel guesses can never get more than the
 * limit through (a read-then-write check would let them all pass before the first failure is recorded).
 * 429 when either budget is spent. Returns a release function: call it after a successful login, so successes never
 * use up the budget; a failed attempt simply keeps its slot.
 */
export async function reserveLoginAttempt(ip, email) {
  const now = Date.now();
  const w = fixedWindow(now, LOGIN_WINDOW_MS);
  const keys = loginFailureKeys(ip, email, now);
  const exp = expiresAtFor(w.endsAt);
  const tooMany = () => new HttpError(429, 'Too many failed attempts, try again in a few minutes.', { retryAfter: w.retryAfter });
  if (!(await bumpBelow(keys.email, env.loginFailMaxPerEmail, exp))) throw tooMany();
  let ipOk = false;
  try {
    ipOk = await bumpBelow(keys.ip, env.loginFailMaxPerIp, exp);
  } finally {
    if (!ipOk) await unbump(keys.email);
  }
  if (!ipOk) throw tooMany();
  return () => Promise.all([unbump(keys.email), unbump(keys.ip)]);
}
