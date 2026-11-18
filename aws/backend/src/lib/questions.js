// Questions table (partition key "id").
import crypto from 'node:crypto';
import { DeleteCommand, GetCommand, PutCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, scanAll, isConditionFailed, nowIso } from './db.js';
import { env } from './config.js';
import { HttpError } from './errors.js';

export const mapQuestion = (q) => ({
  id: q.id,
  text: q.text,
  options: q.options,
  correctIndex: q.correctIndex,
  category: q.category,
  timeLimit: q.timeLimit,
  createdAt: q.createdAt,
});

export const listQuestions = () => scanAll({ TableName: env.questionsTable });

export async function categories() {
  const counts = new Map();
  for (const q of await listQuestions()) counts.set(q.category, (counts.get(q.category) || 0) + 1);
  return [...counts].map(([category, count]) => ({ category, count })).sort((a, b) => a.category.localeCompare(b.category));
}

/** Random sample of `count` questions from the given categories (a name, a list, or empty for all). */
export async function pickRandom(categories, count) {
  const wanted = new Set([categories ?? []].flat().filter(Boolean));
  const all = (await listQuestions()).filter((q) => !wanted.size || wanted.has(q.category));
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  return all.slice(0, count).map(mapQuestion);
}

export async function createQuestion(data, userId) {
  const item = { id: crypto.randomUUID(), ...data, createdBy: userId, createdAt: nowIso() };
  await ddb.send(new PutCommand({ TableName: env.questionsTable, Item: item }));
  return mapQuestion(item);
}

export async function updateQuestion(id, data) {
  const existing = (await ddb.send(new GetCommand({ TableName: env.questionsTable, Key: { id } }))).Item;
  if (!existing) throw new HttpError(404, 'Question not found');
  const item = { ...existing, ...data, id };
  try {
    await ddb.send(new PutCommand({ TableName: env.questionsTable, Item: item, ConditionExpression: 'attribute_exists(id)' }));
  } catch (err) {
    if (isConditionFailed(err)) throw new HttpError(404, 'Question not found');
    throw err;
  }
  return mapQuestion(item);
}

export async function deleteQuestion(id) {
  try {
    await ddb.send(new DeleteCommand({ TableName: env.questionsTable, Key: { id }, ConditionExpression: 'attribute_exists(id)' }));
  } catch (err) {
    if (isConditionFailed(err)) throw new HttpError(404, 'Question not found');
    throw err;
  }
}

/** Insert many questions, skipping ones whose text already exists. Returns how many were added. */
export async function insertMany(questions, userId) {
  const existing = new Set((await listQuestions()).map((q) => q.text.trim().toLowerCase()));
  const fresh = [];
  for (const q of questions) {
    const k = q.text.trim().toLowerCase();
    if (existing.has(k)) continue;
    existing.add(k);
    fresh.push({ id: crypto.randomUUID(), ...q, createdBy: userId ?? null, createdAt: nowIso() });
  }
  for (let i = 0; i < fresh.length; i += 25) {
    let requests = fresh.slice(i, i + 25).map((Item) => ({ PutRequest: { Item } }));
    // BatchWrite may hand back "unprocessed" items under load; retry them.
    for (let attempt = 0; requests.length && attempt < 5; attempt++) {
      const res = await ddb.send(new BatchWriteCommand({ RequestItems: { [env.questionsTable]: requests } }));
      requests = res.UnprocessedItems?.[env.questionsTable] || [];
    }
  }
  return fresh.length;
}
