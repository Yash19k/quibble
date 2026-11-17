// WebSocket $default: every game action the browser sends.
//   browser -> { id, event: 'answer:submit', data: { choice: 2 } }
//   server  -> { type: 'ack', id, ok: true, ... }   (reply to that message)
//   server  -> { type: 'event', event: 'question:show', data }   (broadcasts, see lib/game.js)
import { getConnection } from '../lib/connections.js';
import { getUserById, publicUser } from '../lib/users.js';
import { sendTo, disconnectUser } from '../lib/push.js';
import { GameError } from '../lib/errors.js';
import { wsSchemas, parse } from '../lib/schemas.js';
import * as game from '../lib/game.js';
import { log } from '../lib/log.js';

const actions = {
  hello: (user, d, connectionId) => game.hello(user, connectionId),
  ping: () => ({}),
  'game:create': (user, d) => game.create(user, d),
  'room:join': (user, d) => game.join(user, d),
  'game:start': (user) => game.start(user),
  'game:cancel': (user) => game.cancelByHost(user),
  'room:leave': (user) => game.leave(user),
  'answer:submit': (user, d) => game.submitAnswer(user, d),
};

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

  const action = actions[msg?.event];
  if (!action) {
    await ack({ ok: false, error: 'Unknown action.' });
    return { statusCode: 200 };
  }

  try {
    // Re-check the user on every message so bans apply instantly.
    const conn = await getConnection(connectionId);
    const user = conn && (await getUserById(conn.userId));
    if (!user || user.banned) {
      await ack({ ok: false, error: 'unauthorized' });
      if (user) await disconnectUser(user.id);
      return { statusCode: 200 };
    }
    const data = parse(wsSchemas[msg.event], msg.data);
    const result = await action(publicUser(user), data, connectionId);
    await ack({ ok: true, ...(result || {}) });
  } catch (err) {
    if (err instanceof GameError) await ack({ ok: false, error: err.message });
    else if (err.validation) await ack({ ok: false, error: 'Invalid request.' });
    else {
      log('error', `ws ${msg.event} failed`, { error: err, connectionId });
      await ack({ ok: false, error: 'Something went wrong.' });
    }
  }
  return { statusCode: 200 };
};
