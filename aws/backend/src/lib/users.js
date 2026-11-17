// Users table (partition key "pk"). Three kinds of items:
//   USER#<id>        the user record
//   EMAIL#<email>    uniqueness guard -> { userId }
//   UNAME#<username> uniqueness guard -> { userId }
// Registering writes all three in one transaction with "must not exist" conditions, which is how
// we get UNIQUE(email) and UNIQUE(username) in DynamoDB.
import crypto from 'node:crypto';
import { GetCommand, PutCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, scanAll, isConditionFailed, nowIso } from './db.js';
import { env } from './config.js';
import { HttpError } from './errors.js';

const userKey = (id) => ({ pk: `USER#${id}` });
const emailKey = (email) => ({ pk: `EMAIL#${email.trim().toLowerCase()}` });
const unameKey = (username) => ({ pk: `UNAME#${username.trim().toLowerCase()}` });

export const publicUser = (u) => ({ id: u.id, email: u.email, username: u.username, role: u.role });

export async function createUser({ email, username, passwordHash, role = 'player' }) {
  const id = crypto.randomUUID();
  const user = { ...userKey(id), type: 'user', id, email, username, passwordHash, role, banned: false, createdAt: nowIso() };
  try {
    await ddb.send(new TransactWriteCommand({
      TransactItems: [
        { Put: { TableName: env.usersTable, Item: { ...emailKey(email), type: 'guard', userId: id }, ConditionExpression: 'attribute_not_exists(pk)' } },
        { Put: { TableName: env.usersTable, Item: { ...unameKey(username), type: 'guard', userId: id }, ConditionExpression: 'attribute_not_exists(pk)' } },
        { Put: { TableName: env.usersTable, Item: user, ConditionExpression: 'attribute_not_exists(pk)' } },
      ],
    }));
  } catch (err) {
    if (isConditionFailed(err)) throw new HttpError(409, 'Email or username is already taken');
    throw err;
  }
  return user;
}

export async function getUserById(id) {
  if (!id) return null;
  const res = await ddb.send(new GetCommand({ TableName: env.usersTable, Key: userKey(id) }));
  return res.Item || null;
}

export async function getUserByEmail(email) {
  const guard = await ddb.send(new GetCommand({ TableName: env.usersTable, Key: emailKey(email) }));
  return guard.Item ? getUserById(guard.Item.userId) : null;
}

export async function listUsers() {
  return scanAll({
    TableName: env.usersTable,
    FilterExpression: '#t = :u',
    ExpressionAttributeNames: { '#t': 'type' },
    ExpressionAttributeValues: { ':u': 'user' },
  });
}

/** Admin: change role and/or banned flag. */
export async function updateUser(id, { role, banned }) {
  const sets = [];
  const values = {};
  if (role !== undefined) { sets.push('#r = :r'); values[':r'] = role; }
  if (banned !== undefined) { sets.push('banned = :b'); values[':b'] = banned; }
  try {
    const res = await ddb.send(new UpdateCommand({
      TableName: env.usersTable,
      Key: userKey(id),
      UpdateExpression: `SET ${sets.join(', ')}`,
      ConditionExpression: 'attribute_exists(pk)',
      ExpressionAttributeNames: role !== undefined ? { '#r': 'role' } : undefined,
      ExpressionAttributeValues: values,
      ReturnValues: 'ALL_NEW',
    }));
    return res.Attributes;
  } catch (err) {
    if (isConditionFailed(err)) throw new HttpError(404, 'User not found');
    throw err;
  }
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
