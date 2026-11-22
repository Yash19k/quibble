// Server -> browser messages over the API Gateway WebSocket API.
// Lambdas don't hold sockets; they call the API Gateway Management API ("PostToConnection"),
// which needs the execute-api:ManageConnections IAM permission.
//
// Game broadcasts are sent to the `conns` sets of a game's member items (lib/gamedata.js), read with a strongly
// consistent Query just before sending, so a socket that attached a moment ago is never skipped.
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
  DeleteConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi';
import { env } from './config.js';
import { httpAgents } from './db.js';
import { log } from './log.js';
import { connectionsForUser, deleteConnectionRecord } from './connections.js';

let client;
// The SDK retries throttling (429) itself; keep-alive sockets make a 250-socket fan-out one parallel wave.
const api = () => (client ??= new ApiGatewayManagementApiClient({ endpoint: env.wsEndpoint, requestHandler: httpAgents, maxAttempts: 4 }));

// The local dev server (aws/local) installs a fake transport here instead of API Gateway.
const localTransport = () => globalThis.__QUIBBLE_LOCAL__;

export const isGone = (err) => err?.name === 'GoneException' || err?.$metadata?.httpStatusCode === 410;

/** Send one JSON message to one socket. Resolves 'ok', 'gone' (the socket is closed) or 'failed'. Never throws. */
export async function sendTo(connectionId, message) {
  const data = JSON.stringify(message);
  try {
    const local = localTransport();
    if (local) await local.send(connectionId, data);
    else await api().send(new PostToConnectionCommand({ ConnectionId: connectionId, Data: data }));
    return 'ok';
  } catch (err) {
    if (isGone(err)) return 'gone';
    log('warn', 'postToConnection failed', { connectionId, error: err });
    return 'failed';
  }
}

export const sendEvent = (connectionId, event, data) => sendTo(connectionId, { type: 'event', event, data });

/**
 * Push `event` to every open socket of every member. `dataFn(member, connectionId)` builds each payload (so results can
 * be personalised and `serverNow` stamped at send time); returning null skips that socket.
 * Resolves the sockets that turned out to be closed: [{ member, connectionId }].
 */
export async function emitToMembers(members, event, dataFn) {
  const jobs = [];
  for (const member of members) {
    for (const connectionId of member.conns ?? []) {
      const data = dataFn(member, connectionId);
      if (data == null) continue;
      jobs.push(sendEvent(connectionId, event, data).then((r) => (r === 'gone' ? { member, connectionId } : null)));
    }
  }
  return (await Promise.all(jobs)).filter(Boolean);
}

/** Force-close one socket. API Gateway then runs $disconnect for it, which cleans up its record and presence. */
export async function closeSocket(connectionId) {
  try {
    const local = localTransport();
    if (local) await local.close(connectionId);
    else await api().send(new DeleteConnectionCommand({ ConnectionId: connectionId }));
  } catch (err) {
    if (!isGone(err)) log('warn', 'deleteConnection failed', { error: err });
  }
}

/** Force-close all of a user's sockets (used when an admin bans them). */
export async function disconnectUser(userId) {
  const conns = await connectionsForUser(userId);
  await Promise.all(conns.map(async (c) => {
    await closeSocket(c.connectionId);
    await deleteConnectionRecord(c.connectionId).catch(() => {});
  }));
}
