// Quizzes table (HASH id; GSI byOwner: ownerId + updatedAt): quizzes players build themselves ("My quizzes").
//   { id, ownerId, ownerName, title, description, shared, questions: [...], questionCount, createdAt, updatedAt }
// A quiz is private to its owner unless `shared`: then anyone with its link can host it (but never read its answers).
import crypto from 'node:crypto';
import { DeleteCommand, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, isConditionFailed, nowIso } from './db.js';
import { env } from './config.js';
import { HttpError } from './errors.js';

export const MAX_QUIZZES_PER_USER = 50;

/** What a list shows (no questions). */
export const quizSummary = (q) => ({
  id: q.id,
  title: q.title,
  description: q.description ?? '',
  shared: !!q.shared,
  ownerId: q.ownerId,
  ownerName: q.ownerName,
  questionCount: q.questionCount ?? q.questions?.length ?? 0,
  updatedAt: q.updatedAt,
});

/** Everything, answers included: only ever for the owner. */
export const quizFull = (q) => ({ ...quizSummary(q), questions: q.questions ?? [], createdAt: q.createdAt });

export async function getQuiz(id) {
  const res = await ddb.send(new GetCommand({ TableName: env.quizzesTable, Key: { id }, ConsistentRead: true }));
  return res.Item ?? null;
}

/** The owner's quizzes, most recently edited first. */
export async function listQuizzes(ownerId) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const res = await ddb.send(new QueryCommand({
      TableName: env.quizzesTable,
      IndexName: 'byOwner',
      KeyConditionExpression: 'ownerId = :o',
      ExpressionAttributeValues: { ':o': ownerId },
      ScanIndexForward: false,
      ExclusiveStartKey,
    }));
    items.push(...(res.Items ?? []));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

export async function createQuiz(user, data) {
  // The index is eventually consistent, so a burst of creates could slip one or two past the cap: harmless.
  if ((await listQuizzes(user.id)).length >= MAX_QUIZZES_PER_USER) {
    throw new HttpError(400, `You can keep up to ${MAX_QUIZZES_PER_USER} quizzes. Delete one to make room.`);
  }
  const now = nowIso();
  const item = {
    id: crypto.randomUUID(), ownerId: user.id, ownerName: user.username, ...data,
    questionCount: data.questions.length, createdAt: now, updatedAt: now,
  };
  await ddb.send(new PutCommand({ TableName: env.quizzesTable, Item: item, ConditionExpression: 'attribute_not_exists(id)' }));
  return item;
}

export async function updateQuiz(user, id, data) {
  const existing = await getQuiz(id);
  if (!existing || existing.ownerId !== user.id) throw new HttpError(404, 'Quiz not found');
  const item = {
    ...existing, ...data, ownerName: user.username, questionCount: data.questions.length, updatedAt: nowIso(),
  };
  try {
    await ddb.send(new PutCommand({
      TableName: env.quizzesTable, Item: item,
      ConditionExpression: 'ownerId = :o', ExpressionAttributeValues: { ':o': user.id },
    }));
  } catch (err) {
    if (isConditionFailed(err)) throw new HttpError(404, 'Quiz not found');
    throw err;
  }
  return item;
}

export async function deleteQuiz(user, id) {
  try {
    await ddb.send(new DeleteCommand({
      TableName: env.quizzesTable, Key: { id },
      ConditionExpression: 'ownerId = :o', ExpressionAttributeValues: { ':o': user.id },
    }));
  } catch (err) {
    if (isConditionFailed(err)) throw new HttpError(404, 'Quiz not found');
    throw err;
  }
}
