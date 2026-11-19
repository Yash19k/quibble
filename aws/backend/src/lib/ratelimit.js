// Per-client abuse protection: fixed-window counters in the RateLimits table (TTL on expiresAt).
// API Gateway stage throttling protects the APIs as a whole; these limits are per IP / per account, sized (config.js)
// so a whole classroom behind one Wi-Fi IP can sign up and log in at the same time.
import crypto from 'node:crypto';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, isConditionFailed } from './db.js';
import { env } from './config.js';
import { HttpError } from './errors.js';

const REGISTER_WINDOW_MS = 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

/** The fixed window `now` falls in: its index, when it ends (ms) and the whole seconds left until then. */
export function fixedWindow(now, windowMs) {
  const index = Math.floor(now / windowMs);
  const endsAt = (index + 1) * windowMs;
  return { index, endsAt, retryAfter: Math.max(1, Math.ceil((endsAt - now) / 1000)) };
}

// Hashed so the table never holds the addresses people typed (typos of other people's emails included).
const emailId = (email) =>
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

async function hitsOf(key) {
  const res = await ddb.send(new GetCommand({ TableName: env.rateLimitsTable, Key: { key }, ProjectionExpression: 'hits' }));
  return res.Item?.hits ?? 0;
}

/** 429 if this IP or this account had too many failed logins in the current 15-minute window. Read-only. */
export async function assertLoginAllowed(ip, email) {
  const now = Date.now();
  const keys = loginFailureKeys(ip, email, now);
  const [ipHits, emailHits] = await Promise.all([hitsOf(keys.ip), hitsOf(keys.email)]);
  if (ipHits >= env.loginFailMaxPerIp || emailHits >= env.loginFailMaxPerEmail) {
    const { retryAfter } = fixedWindow(now, LOGIN_WINDOW_MS);
    throw new HttpError(429, 'Too many failed attempts, try again in a few minutes.', { retryAfter });
  }
}

/** A wrong password or unknown email: count it against both the IP and the account. Successful logins never count. */
export async function recordLoginFailure(ip, email) {
  const now = Date.now();
  const keys = loginFailureKeys(ip, email, now);
  const exp = expiresAtFor(fixedWindow(now, LOGIN_WINDOW_MS).endsAt);
  await Promise.all([keys.ip, keys.email].map((key) => ddb.send(new UpdateCommand({
    TableName: env.rateLimitsTable,
    Key: { key },
    UpdateExpression: 'ADD hits :one SET expiresAt = :exp',
    ExpressionAttributeValues: { ':one': 1, ':exp': exp },
  }))));
}
