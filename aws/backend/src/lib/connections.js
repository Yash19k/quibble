// Connections table: one item per open WebSocket.
//   connectionId (PK), userId, gameCode?, seat?, tokenIat, connectedAt, expiresAt (TTL)
// GSI byUser (userId) reaches all of a user's tabs (attaching other tabs to a game, closing a banned user's sockets).
// Game broadcasts never come from this table: their targets are the `conns` sets on the game's member items
// (lib/gamedata.js), read with a strongly consistent Query.
import { DeleteCommand, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, queryAll, isConditionFailed, nowIso } from './db.js';
import { env } from './config.js';

const TTL_SECONDS = 3 * 60 * 60; // API Gateway closes sockets after 2 h anyway

export async function saveConnection(connectionId, userId, tokenIat) {
  await ddb.send(new PutCommand({
    TableName: env.connectionsTable,
    Item: { connectionId, userId, tokenIat, connectedAt: nowIso(), expiresAt: Math.floor(Date.now() / 1000) + TTL_SECONDS },
  }));
}

/** Strongly consistent by default: the record may have been written milliseconds ago ($connect, attach). */
export async function getConnection(connectionId, { consistent = true } = {}) {
  const res = await ddb.send(new GetCommand({ TableName: env.connectionsTable, Key: { connectionId }, ConsistentRead: consistent }));
  return res.Item || null;
}

/** Deletes the record and returns what it held (null if it was already gone). */
export async function deleteConnectionRecord(connectionId) {
  const res = await ddb.send(new DeleteCommand({ TableName: env.connectionsTable, Key: { connectionId }, ReturnValues: 'ALL_OLD' }));
  return res.Attributes || null;
}

/** All open sockets of a user (GSI, eventually consistent: a socket opened a moment ago may be missing). */
export async function connectionsForUser(userId) {
  return queryAll({
    TableName: env.connectionsTable,
    IndexName: 'byUser',
    KeyConditionExpression: '#u = :u',
    ExpressionAttributeNames: { '#u': 'userId' },
    ExpressionAttributeValues: { ':u': userId },
  });
}

/** Point a socket at a game (and its seat; 0 = presenter). False if the socket is already closed. */
export async function setConnectionGame(connectionId, code, seat) {
  try {
    await ddb.send(new UpdateCommand({
      TableName: env.connectionsTable,
      Key: { connectionId },
      UpdateExpression: 'SET #g = :g, #s = :s',
      ConditionExpression: 'attribute_exists(#id)', // never resurrect a closed socket's record
      ExpressionAttributeNames: { '#g': 'gameCode', '#s': 'seat', '#id': 'connectionId' },
      ExpressionAttributeValues: { ':g': code, ':s': seat ?? 0 },
    }));
    return true;
  } catch (err) {
    if (isConditionFailed(err)) return false;
    throw err;
  }
}

/** Take a socket out of a game, if it still points at that game. */
export async function clearConnectionGame(connectionId, code) {
  try {
    await ddb.send(new UpdateCommand({
      TableName: env.connectionsTable,
      Key: { connectionId },
      UpdateExpression: 'REMOVE #g, #s',
      ConditionExpression: '#g = :g',
      ExpressionAttributeNames: { '#g': 'gameCode', '#s': 'seat' },
      ExpressionAttributeValues: { ':g': code },
    }));
  } catch (err) {
    if (!isConditionFailed(err)) throw err;
  }
}
