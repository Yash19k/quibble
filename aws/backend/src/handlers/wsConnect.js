// WebSocket $connect: authenticate the handshake (wss://...?token=JWT) and remember the socket.
// Returning a non-2xx status makes API Gateway reject the connection.
import { userFromToken } from '../lib/auth.js';
import { saveConnection } from '../lib/connections.js';
import { log } from '../lib/log.js';

export const handler = async (event) => {
  const token = event.queryStringParameters?.token;
  const user = await userFromToken(token);
  if (!user) return { statusCode: 401, body: 'unauthorized' };
  await saveConnection(event.requestContext.connectionId, user.id);
  log('info', 'socket connected', { userId: user.id, connectionId: event.requestContext.connectionId });
  return { statusCode: 200, body: 'ok' };
};
