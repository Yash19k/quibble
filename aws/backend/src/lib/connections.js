// Connections table: one item per open WebSocket.
//   connectionId (PK), userId, gameCode (optional), connectedAt, expiresAt (TTL)
// GSIs: byUser (userId) to reach / kick all of a user's tabs, byGame (gameCode) to broadcast.
import { DeleteCommand, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, queryAll, isConditionFailed, nowIso } from './db.js';
import { env } from './config.js';

const TTL_SECONDS = 3 * 60 * 60; // API Gateway closes sockets after 2h anyway

export async function saveConnection(connectionId, userId) {
  await ddb.send(new PutCommand({
    TableName: env.connectionsTable,
    Item: { connectionId, userId, connectedAt: nowIso(), expiresAt: Math.floor(Date.now() / 1000) + TTL_SECONDS },
  }));
}

export async function getConnection(connectionId) {
  const res = await ddb.send(new GetCommand({ TableName: env.connectionsTable, Key: { connectionId } }));
  return res.Item || null;
}

export async function deleteConnectionRecord(connectionId) {
  await ddb.send(new DeleteCommand({ TableName: env.connectionsTable, Key: { connectionId } }));
}

export async function connectionsForUser(userId) {
  return queryAll({
    TableName: env.connectionsTable,
    IndexName: 'byUser',
    KeyConditionExpression: 'userId = :u',
    ExpressionAttributeValues: { ':u': userId },
  });
}

export async function connectionsForGame(code) {
  return queryAll({
    TableName: env.connectionsTable,
    IndexName: 'byGame',
    KeyConditionExpression: 'gameCode = :g',
    ExpressionAttributeValues: { ':g': code },
  });
}

async function setGame(connectionId, code) {
  try {
    await ddb.send(new UpdateCommand({
      TableName: env.connectionsTable,
      Key: { connectionId },
      UpdateExpression: code ? 'SET gameCode = :g' : 'REMOVE gameCode',
      ConditionExpression: 'attribute_exists(connectionId)', // don't resurrect a closed socket
      ExpressionAttributeValues: code ? { ':g': code } : undefined,
    }));
  } catch (err) {
    if (!isConditionFailed(err)) throw err;
  }
}

/** Subscribe every open tab of this user to a game's broadcasts. */
export async function attachUserToGame(userId, code) {
  const conns = await connectionsForUser(userId);
  await Promise.all(conns.map((c) => setGame(c.connectionId, code)));
}

/** Unsubscribe this user's tabs from a game. */
export async function detachUserFromGame(userId, code) {
  const conns = await connectionsForUser(userId);
  await Promise.all(conns.filter((c) => c.gameCode === code).map((c) => setGame(c.connectionId, null)));
}

/** Unsubscribe everyone from a finished / cancelled game. */
export async function detachAllFromGame(code) {
  const conns = await connectionsForGame(code);
  await Promise.all(conns.map((c) => setGame(c.connectionId, null)));
}
