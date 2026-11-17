// Server -> browser messages over the API Gateway WebSocket API.
// Lambdas don't hold sockets; they call the API Gateway Management API ("PostToConnection"),
// which needs the execute-api:ManageConnections IAM permission.
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
  DeleteConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi';
import { env } from './config.js';
import { log } from './log.js';
import { connectionsForGame, connectionsForUser, deleteConnectionRecord } from './connections.js';

let client;
const api = () => (client ??= new ApiGatewayManagementApiClient({ endpoint: env.wsEndpoint }));

// The local dev server (aws/local) installs a fake transport here instead of API Gateway.
const localTransport = () => globalThis.__QUIBBLE_LOCAL__;

const isGone = (err) => err?.name === 'GoneException' || err?.$metadata?.httpStatusCode === 410;

/** Send one JSON message to one socket. Stale sockets are cleaned up. */
export async function sendTo(connectionId, message) {
  const data = JSON.stringify(message);
  try {
    const local = localTransport();
    if (local) await local.send(connectionId, data);
    else await api().send(new PostToConnectionCommand({ ConnectionId: connectionId, Data: data }));
    return true;
  } catch (err) {
    if (isGone(err)) await deleteConnectionRecord(connectionId).catch(() => {});
    else log('warn', 'postToConnection failed', { connectionId, error: err });
    return false;
  }
}

export const sendEvent = (connectionId, event, data) => sendTo(connectionId, { type: 'event', event, data });

export async function emitToGame(code, event, data) {
  const conns = await connectionsForGame(code);
  await Promise.all(conns.map((c) => sendEvent(c.connectionId, event, data)));
}

/** Force-close all of a user's sockets (used when an admin bans them). */
export async function disconnectUser(userId) {
  const conns = await connectionsForUser(userId);
  await Promise.all(conns.map(async (c) => {
    try {
      const local = localTransport();
      if (local) await local.close(c.connectionId);
      else await api().send(new DeleteConnectionCommand({ ConnectionId: c.connectionId }));
    } catch (err) {
      if (!isGone(err)) log('warn', 'deleteConnection failed', { error: err });
    }
    await deleteConnectionRecord(c.connectionId).catch(() => {});
  }));
}
