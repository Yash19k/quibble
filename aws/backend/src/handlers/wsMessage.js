// WebSocket $default: every game action the browser sends.
//   browser -> { id, event: 'answer:submit', data: { code, index, choice } }
//   server  -> { type: 'ack', id, ok: true, ... }   (reply to that message)
//   server  -> { type: 'event', event: 'question:show', data }   (pushes, see lib/game.js)
// Browsers resend unacknowledged messages, so every action is idempotent.
import { getConnection } from '../lib/connections.js';
import { getUserById } from '../lib/users.js';
import { sendTo, disconnectUser } from '../lib/push.js';
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
    // Strongly consistent: the socket and the user may have been created milliseconds ago. Re-read the user on
    // every message so bans apply instantly.
    const conn = await getConnection(connectionId);
    const user = conn && (await getUserById(conn.userId, { consistent: true }));
    if (!user || user.banned) {
      await ack({ ok: false, error: 'unauthorized' });
      if (user) await disconnectUser(user.id);
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
