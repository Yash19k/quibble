// Connections table: one item per open WebSocket.
//   connectionId (PK), userId, gameCode?, seat?, tokenIat, tokenSv, connectedAt, expiresAt (TTL)
// GSI byUser (userId) reaches all of a user's tabs (attaching other tabs to a game, closing a banned user's sockets).
// Game broadcasts never come from this table: their targets are the `conns` sets on the game's member items
// (lib/gamedata.js), read with a strongly consistent Query.
import { DeleteCommand, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { plain } from './gamedata.js';
import { ddb, queryAll, isConditionFailed, nowIso } from './db.js';
import { env } from './config.js';

const TTL_SECONDS = 3 * 60 * 60; // API Gateway closes sockets after 2 h anyway

export async function saveConnection(connectionId, userId, tokenIat, tokenSv = 0) {
  await ddb.send(new PutCommand({
    TableName: env.connectionsTable,
    Item: { connectionId, userId, tokenIat, tokenSv, connectedAt: nowIso(), expiresAt: Math.floor(Date.now() / 1000) + TTL_SECONDS },
  }));
}

/** Strongly consistent by default: the record may have been written milliseconds ago ($connect, attach). */
export async function getConnection(connectionId, { consistent = true } = {}) {
  const res = await ddb.send(new GetCommand({ TableName: env.connectionsTable, Key: { connectionId }, ConsistentRead: consistent }));
  return res.Item || null;
}

// ---------- per-socket message budget ----------
// API Gateway can only throttle a whole stage, so one scripted client could otherwise flood messages and use up the
// account's shared Lambda concurrency for everyone. Each message counts against its socket in a fixed window, kept on
// the connection record itself: the read every message needs anyway becomes one atomic update.
export const MSG_WINDOW_MS = 10_000;
const MSG_COUNT_CAP = 1000; // counting stops here: the socket is closed long before

/**
 * Count one message on this socket and return its record (with `rlHits` = messages in the current window), or null
 * if the socket's record is gone (closed or never registered). Strongly consistent, like getConnection.
 */
export async function touchConnection(connectionId, now = Date.now()) {
  const win = Math.floor(now / MSG_WINDOW_MS);
  const base = { TableName: env.connectionsTable, Key: { connectionId }, ReturnValues: 'ALL_NEW' };
  for (let attempt = 0; attempt < 2; attempt++) {
    let old = null;
    try {
      // The usual case for a real player (about one message per window): the first message of a window starts the
      // count over. One write, like the read it replaces.
      const res = await ddb.send(new UpdateCommand({
        ...base,
        UpdateExpression: 'SET rlWin = :w, rlHits = :one',
        ConditionExpression: 'attribute_exists(connectionId) AND (attribute_not_exists(rlWin) OR rlWin <> :w)',
        ExpressionAttributeValues: { ':one': 1, ':w': win },
        ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
      }));
      return res.Attributes;
    } catch (err) {
      if (!isConditionFailed(err)) throw err;
      old = plain(err.Item); // ALL_OLD of a failed condition (DynamoDB JSON); absent when there is no record
    }
    // Another message in the same window. A socket already far past the limit isn't counted any further.
    if ((Number(old?.rlHits) || 0) > MSG_COUNT_CAP) return old;
    try {
      const res = await ddb.send(new UpdateCommand({
        ...base,
        UpdateExpression: 'ADD rlHits :one',
        ConditionExpression: 'attribute_exists(connectionId) AND rlWin = :w',
        ExpressionAttributeValues: { ':one': 1, ':w': win },
      }));
      return res.Attributes;
    } catch (err) {
      if (!isConditionFailed(err)) throw err;
      // The window rolled over between the two writes (or the socket closed): go round once more.
    }
  }
  return getConnection(connectionId);
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
