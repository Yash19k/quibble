// WebSocket $connect: authenticate the handshake (wss://...?token=JWT) and remember the socket.
// Returning a non-2xx status makes API Gateway reject the connection.
import { verifyToken } from '../lib/auth.js';
import { getUserById } from '../lib/users.js';
import { saveConnection } from '../lib/connections.js';
import { log } from '../lib/log.js';

export const handler = async (event) => {
  const claims = verifyToken(event.queryStringParameters?.token);
  // Strongly consistent: the browser opens its socket right after signing up.
  const user = claims && (await getUserById(claims.userId, { consistent: true }));
  if (!user || user.banned) return { statusCode: 401, body: 'unauthorized' };
  // tokenIat lets `hello` hand out a fresh token before a long event outlives the old one.
  await saveConnection(event.requestContext.connectionId, user.id, claims.iat);
  log('info', 'socket connected', { userId: user.id, connectionId: event.requestContext.connectionId });
  return { statusCode: 200, body: 'ok' };
};
