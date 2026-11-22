// WebSocket $default: every game action the browser sends.
//   browser -> { id, event: 'answer:submit', data: { code, index, choice } }
//   server  -> { type: 'ack', id, ok: true, ... }   (reply to that message)
//   server  -> { type: 'event', event: 'question:show', data }   (pushes, see lib/game.js)
// Browsers resend unacknowledged messages, so every action is idempotent.
import { touchConnection } from '../lib/connections.js';
import { getUserById, tokenRevoked } from '../lib/users.js';
import { sendTo, disconnectUser, closeSocket } from '../lib/push.js';
import { GameError } from '../lib/errors.js';
import { wsSchemas, parse } from '../lib/schemas.js';
import * as game from '../lib/game.js';
import { log } from '../lib/log.js';

const actions = {
  hello: game.hello,
  sync: game.hello,
  ping: () => ({ serverNow: Date.now() }),
  'game:create': game.create,
  'room:join': game.join,
  'game:start': game.start,
  'game:cancel': game.cancelByHost,
  'room:leave': game.leave,
  'answer:submit': game.submitAnswer,
  react: game.react,
};

// Messages per socket per 10 s window (connections.MSG_WINDOW_MS). A real page sends a handful per question (answer,
// reactions at most every 600 ms, resends); past the soft limit messages are refused without doing any work, past
// the hard limit the socket is closed.
const MSG_SOFT_LIMIT = 60;
const MSG_HARD_LIMIT = 150;

// Infrastructure hiccups (throttling, timeouts) are worth a resend; the browser does that when it sees `retry`.
const isTransient = (err) =>
  /Throttl|ProvisionedThroughputExceeded|RequestLimitExceeded|TransactionConflict|TransactionCanceled|TimeoutError|ECONNRESET|ETIMEDOUT|ServiceUnavailable|InternalServerError/i
    .test(`${err?.name} ${err?.code} ${err?.message}`);

export const handler = async (event) => {
  const connectionId = event.requestContext.connectionId;
  let msg;
  try {
    msg = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400 };
  }
  const id = msg?.id;
  const ack = (payload) => sendTo(connectionId, { type: 'ack', id, ...payload });

  // Own properties only: "constructor", "__proto__", "toString"... must not resolve to Object.prototype members.
  const name = typeof msg?.event === 'string' ? msg.event : '';
  const action = Object.hasOwn(actions, name) && Object.hasOwn(wsSchemas, name) ? actions[name] : null;
  if (!action) {
    await ack({ ok: false, error: 'Unknown action.' });
    return { statusCode: 200 };
  }

  const deferred = [];
  try {
    // Strongly consistent: the socket and the user may have been created milliseconds ago. Counting the message
    // against this socket's budget is part of the same (single) read of its record.
    const conn = await touchConnection(connectionId);
    const hits = Number(conn?.rlHits) || 0;
    if (hits > MSG_HARD_LIMIT) {
      // Far beyond any real player (a script): drop this socket. A real page would reconnect and resync.
      if (hits === MSG_HARD_LIMIT + 1) log('warn', 'closing a flooding socket', { connectionId, userId: conn.userId, hits });
      await closeSocket(connectionId);
      return { statusCode: 200 };
    }
    if (hits > MSG_SOFT_LIMIT) {
      await ack({ ok: false, error: 'Too many requests. Slow down a little.' });
      return { statusCode: 200 };
    }
    // Re-read the user on every message so bans apply instantly.
    const user = conn && (await getUserById(conn.userId, { consistent: true }));
    if (!user || user.banned) {
      await ack({ ok: false, error: 'unauthorized' });
      if (user) await disconnectUser(user.id);
      return { statusCode: 200 };
    }
    // A socket opened with a token from before an admin's "sign out everywhere" is as dead as that token (only this
    // socket: the user may already have signed in again elsewhere).
    if (tokenRevoked(user, conn.tokenSv)) {
      await ack({ ok: false, error: 'unauthorized' });
      return { statusCode: 200 };
    }
    const ctx = {
      connectionId,
      conn,
      // When API Gateway received this frame: answer deadlines and speed points use it, so a cold start or a
      // throttled-and-resent message never costs the player.
      now: Number(event.requestContext.requestTimeEpoch) || Date.now(),
      defer: (fn) => deferred.push(fn),
    };
    const data = parse(wsSchemas[msg.event], msg.data);
    const result = await action(user, data, ctx);
    await ack({ ok: true, ...(result || {}) });
  } catch (err) {
    if (err instanceof GameError) await ack({ ok: false, error: err.message });
    else if (err.validation) await ack({ ok: false, error: 'Invalid request.' });
    else {
      log('error', `ws ${msg.event} failed`, { error: err, connectionId });
      await ack({ ok: false, error: 'The server is busy, please try again.', retry: isTransient(err) });
    }
  }

  // Work that must not delay the player's acknowledgement (closing a question early, lobby pushes).
  for (const fn of deferred) {
    try {
      await fn();
    } catch (error) {
      log('error', `deferred work after ${msg.event} failed`, { error, connectionId });
    }
  }
  return { statusCode: 200 };
};
