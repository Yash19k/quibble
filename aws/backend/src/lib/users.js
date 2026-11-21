// Users table (partition key "pk"). Three kinds of items:
//   USER#<id>        the user record
//   EMAIL#<email>    uniqueness guard -> { userId }
//   UNAME#<username> uniqueness guard -> { userId }
// Registering writes all three in one transaction with "must not exist" conditions, which is how
// we get UNIQUE(email) and UNIQUE(username) in DynamoDB.
import crypto from 'node:crypto';
import { GetCommand, PutCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, scanAll, isConditionFailed, nowIso, sleep } from './db.js';
import { env } from './config.js';
import { HttpError } from './errors.js';

export const userKey = (id) => ({ pk: `USER#${id}` });
const emailKey = (email) => ({ pk: `EMAIL#${email.trim().toLowerCase()}` });
const unameKey = (username) => ({ pk: `UNAME#${username.trim().toLowerCase()}` });

export const publicUser = (u) => ({ id: u.id, email: u.email, username: u.username, role: u.role });

/**
 * Was this token signed before an admin signed the user out everywhere? Tokens carry the user's session version
 * (`sv`, absent = 0) and every sign-out bumps it, so exactly the tokens issued before it stop working.
 */
export const tokenRevoked = (user, sv) => (sv ?? 0) !== (user?.sessionVersion ?? 0);

const reasonCode = (err, i) => err?.CancellationReasons?.[i]?.Code;

/**
 * Registers a user. Uniqueness of email and username comes from guard items written in the same transaction.
 * A taken email/username -> 409 with `extra.field`. Throttling / transaction conflicts (e.g. a double-submitted form
 * whose first attempt is still running) are retried here; if they persist -> 503 so the client retries later.
 */
export async function createUser({ email, username, passwordHash, role = 'player' }) {
  for (let attempt = 0; ; attempt++) {
    const id = crypto.randomUUID();
    const createdAt = nowIso();
    const user = { ...userKey(id), type: 'user', id, email, username, passwordHash, role, banned: false, createdAt, lastLoginAt: createdAt };
    try {
      await ddb.send(new TransactWriteCommand({
        TransactItems: [
          { Put: { TableName: env.usersTable, Item: { ...emailKey(email), type: 'guard', userId: id }, ConditionExpression: 'attribute_not_exists(pk)' } },
          { Put: { TableName: env.usersTable, Item: { ...unameKey(username), type: 'guard', userId: id }, ConditionExpression: 'attribute_not_exists(pk)' } },
          { Put: { TableName: env.usersTable, Item: user, ConditionExpression: 'attribute_not_exists(pk)' } },
        ],
      }));
      return user;
    } catch (err) {
      if (reasonCode(err, 0) === 'ConditionalCheckFailed') {
        throw new HttpError(409, 'That email is already registered', { field: 'email' });
      }
      if (reasonCode(err, 1) === 'ConditionalCheckFailed') {
        throw new HttpError(409, 'That username is taken', { field: 'username' });
      }
      const retryable =
        reasonCode(err, 2) === 'ConditionalCheckFailed' || // astronomically unlikely id clash: new id
        err?.name === 'TransactionCanceledException' || // TransactionConflict / ThrottlingError
        err?.name === 'TransactionConflictException' ||
        err?.name === 'ThrottlingException' ||
        err?.name === 'ProvisionedThroughputExceededException' ||
        err?.name === 'RequestLimitExceeded';
      if (!retryable) throw err;
      if (attempt >= 3) throw new HttpError(503, 'Server busy, please try again.');
      await sleep(100 * 3 ** attempt + Math.random() * 100);
    }
  }
}

/** `consistent: true` right after a write (e.g. the socket opened just after sign-up) or when acting on the result. */
export async function getUserById(id, { consistent = false } = {}) {
  if (!id) return null;
  const res = await ddb.send(new GetCommand({ TableName: env.usersTable, Key: userKey(id), ConsistentRead: consistent }));
  return res.Item || null;
}

export async function getUserByEmail(email, { consistent = false } = {}) {
  const guard = await ddb.send(new GetCommand({ TableName: env.usersTable, Key: emailKey(email), ConsistentRead: consistent }));
  return guard.Item ? getUserById(guard.Item.userId, { consistent }) : null;
}

export async function listUsers() {
  return scanAll({
    TableName: env.usersTable,
    FilterExpression: '#t = :u',
    ExpressionAttributeNames: { '#t': 'type' },
    ExpressionAttributeValues: { ':u': 'user' },
  });
}

/**
 * Admin: change role and/or banned flag. A ban records why, when and by whom (banReason, bannedAt, bannedBy); an unban
 * clears them again.
 */
export async function updateUser(id, { role, banned, banReason, bannedBy }) {
  const sets = [];
  const removes = [];
  const names = {};
  const values = {};
  if (role !== undefined) { sets.push('#r = :r'); names['#r'] = 'role'; values[':r'] = role; }
  if (banned === true) {
    sets.push('banned = :b', 'bannedAt = :at');
    values[':b'] = true;
    values[':at'] = nowIso();
    if (banReason) { sets.push('banReason = :why'); values[':why'] = banReason; } else removes.push('banReason');
    if (bannedBy) { sets.push('bannedBy = :by'); values[':by'] = bannedBy; }
  } else if (banned === false) {
    sets.push('banned = :b');
    values[':b'] = false;
    removes.push('banReason', 'bannedAt', 'bannedBy');
  }
  try {
    const res = await ddb.send(new UpdateCommand({
      TableName: env.usersTable,
      Key: userKey(id),
      UpdateExpression: `SET ${sets.join(', ')}${removes.length ? ` REMOVE ${removes.join(', ')}` : ''}`,
      ConditionExpression: 'attribute_exists(pk)',
      ExpressionAttributeNames: Object.keys(names).length ? names : undefined,
      ExpressionAttributeValues: values,
      ReturnValues: 'ALL_NEW',
    }));
    return res.Attributes;
  } catch (err) {
    if (isConditionFailed(err)) throw new HttpError(404, 'User not found');
    throw err;
  }
}

/** A successful login, shown in the admin panel's "Last login" column. */
export async function touchLogin(id) {
  await ddb.send(new UpdateCommand({
    TableName: env.usersTable,
    Key: userKey(id),
    UpdateExpression: 'SET lastLoginAt = :now',
    ConditionExpression: 'attribute_exists(pk)',
    ExpressionAttributeValues: { ':now': nowIso() },
  }));
}

/**
 * Admin: rename a user. The username guard is swapped in the same transaction, so a taken name -> 409 and nothing
 * changes. A change of capitals only keeps the (case-insensitive) guard.
 */
export async function renameUser(id, username) {
  const user = await getUserById(id, { consistent: true });
  if (!user) throw new HttpError(404, 'User not found');
  if (user.username === username) return user;
  const sameGuard = user.username.trim().toLowerCase() === username.trim().toLowerCase();
  const setName = {
    Update: {
      TableName: env.usersTable,
      Key: userKey(id),
      UpdateExpression: 'SET username = :n',
      ConditionExpression: 'attribute_exists(pk) AND username = :old',
      ExpressionAttributeValues: { ':n': username, ':old': user.username },
    },
  };
  const items = sameGuard ? [setName] : [
    { Put: { TableName: env.usersTable, Item: { ...unameKey(username), type: 'guard', userId: id }, ConditionExpression: 'attribute_not_exists(pk)' } },
    setName,
    {
      Delete: {
        TableName: env.usersTable, Key: unameKey(user.username),
        ConditionExpression: 'attribute_not_exists(pk) OR userId = :id', ExpressionAttributeValues: { ':id': id },
      },
    },
  ];
  try {
    await ddb.send(new TransactWriteCommand({ TransactItems: items }));
  } catch (err) {
    if (!sameGuard && reasonCode(err, 0) === 'ConditionalCheckFailed') throw new HttpError(409, 'That username is taken', { field: 'username' });
    if (err?.name === 'TransactionCanceledException') throw new HttpError(409, 'This user just changed. Reload and try again.');
    throw err;
  }
  return { ...user, username };
}

/**
 * Admin: sign the user out on every device (every token issued so far stops working, see tokenRevoked). With
 * `passwordHash` it also sets a new password: the reset-password flow.
 */
export async function revokeSessions(id, { passwordHash } = {}) {
  const sets = ['sessionsRevokedAt = :now'];
  const values = { ':now': nowIso(), ':one': 1 };
  if (passwordHash) {
    sets.push('passwordHash = :h', 'passwordResetAt = :now');
    values[':h'] = passwordHash;
  }
  try {
    await ddb.send(new UpdateCommand({
      TableName: env.usersTable,
      Key: userKey(id),
      UpdateExpression: `SET ${sets.join(', ')} ADD sessionVersion :one`,
      ConditionExpression: 'attribute_exists(pk)',
      ExpressionAttributeValues: values,
    }));
  } catch (err) {
    if (isConditionFailed(err)) throw new HttpError(404, 'User not found');
    throw err;
  }
}

/** Admin: remove the user record and its email / username guards in one transaction. */
export async function deleteUserRecords(user) {
  const guard = (Key) => ({
    Delete: { TableName: env.usersTable, Key, ConditionExpression: 'attribute_not_exists(pk) OR userId = :id', ExpressionAttributeValues: { ':id': user.id } },
  });
  await ddb.send(new TransactWriteCommand({
    TransactItems: [
      { Delete: { TableName: env.usersTable, Key: userKey(user.id) } },
      guard(emailKey(user.email)),
      guard(unameKey(user.username)),
    ],
  }));
}

/** Remember which game a user is in (so a refresh / reconnect puts them back). */
export async function setCurrentGame(userId, code) {
  await ddb.send(new UpdateCommand({
    TableName: env.usersTable,
    Key: userKey(userId),
    UpdateExpression: 'SET currentGame = :c',
    ConditionExpression: 'attribute_exists(pk)',
    ExpressionAttributeValues: { ':c': code },
  }));
}

/** Clear currentGame, but only if it still points at this game. */
export async function clearCurrentGame(userId, code) {
  try {
    await ddb.send(new UpdateCommand({
      TableName: env.usersTable,
      Key: userKey(userId),
      UpdateExpression: 'REMOVE currentGame',
      ConditionExpression: 'currentGame = :c',
      ExpressionAttributeValues: { ':c': code },
    }));
  } catch (err) {
    if (!isConditionFailed(err)) throw err;
  }
}

/** Used by the seed script: create or upgrade the admin account. */
export async function upsertAdmin({ email, username, passwordHash }) {
  const existing = await getUserByEmail(email);
  if (existing) {
    await ddb.send(new PutCommand({ TableName: env.usersTable, Item: { ...existing, role: 'admin', banned: false } }));
    return { user: existing, created: false };
  }
  return { user: await createUser({ email, username, passwordHash, role: 'admin' }), created: true };
}
