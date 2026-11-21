// Questions table (partition key "id").
// Creating a game, listing categories and the admin panel all need the whole (small) table, so reads go through a
// short per-container cache: a crowd hitting the API at once costs one Scan per warm Lambda, not one per request.
import crypto from 'node:crypto';
import { DeleteCommand, GetCommand, PutCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, scanAll, isConditionFailed, nowIso, sleep } from './db.js';
import { env } from './config.js';
import { HttpError } from './errors.js';
import { cleanQuestion, typeOf, TYPES } from './qtypes.js';

const CACHE_TTL_MS = 30_000;

export const mapQuestion = (q) => ({ id: q.id, ...cleanQuestion(q), createdAt: q.createdAt });

/**
 * Caches what `load()` resolves to for `ttlMs`. Concurrent callers share one in-flight load (single-flight) and
 * failures are never cached. `get({ fresh: true })` always starts a new load and caches that one instead.
 */
export function asyncCache(load, ttlMs, clock = Date.now) {
  let entry = null; // { at, promise }
  return {
    get({ fresh = false } = {}) {
      if (!fresh && entry && clock() - entry.at < ttlMs) return entry.promise;
      const mine = { at: clock(), promise: null };
      mine.promise = Promise.resolve()
        .then(load)
        .catch((err) => {
          if (entry === mine) entry = null; // the next caller tries again
          throw err;
        });
      entry = mine;
      return mine.promise;
    },
    invalidate() {
      entry = null;
    },
  };
}

// Strongly consistent, so the reload right after an admin edit (and the refill after invalidate) includes it.
// Frozen because every caller shares the same array.
const cache = asyncCache(
  async () => Object.freeze(await scanAll({ TableName: env.questionsTable, ConsistentRead: true })),
  CACHE_TTL_MS
);

/** Every question (cached up to 30 s per container; read-only). `fresh` skips the cache, e.g. for the admin panel. */
export const listQuestions = ({ fresh = false } = {}) => cache.get({ fresh });

/** Runs a write, then drops this container's cache (also on failure: a timed-out write may still have landed). */
async function changing(write) {
  try {
    return await write();
  } finally {
    cache.invalidate();
  }
}

export async function categories() {
  const counts = new Map();
  for (const q of await listQuestions()) counts.set(q.category, (counts.get(q.category) || 0) + 1);
  return [...counts].map(([category, count]) => ({ category, count })).sort((a, b) => a.category.localeCompare(b.category));
}

/** How many questions of each type the bank holds, per category: [{ type, count, byCategory: {cat: n} }]. */
export async function typeCounts() {
  const out = new Map(TYPES.map((t) => [t, { type: t, count: 0, byCategory: {} }]));
  for (const q of await listQuestions()) {
    const t = out.get(typeOf(q));
    t.count += 1;
    t.byCategory[q.category] = (t.byCategory[q.category] || 0) + 1;
  }
  return [...out.values()];
}

/** `count` distinct items in random order (partial Fisher-Yates on a copy; the input is left alone). */
export function sample(items, count) {
  const pool = [...items];
  const n = Math.max(0, Math.min(count ?? pool.length, pool.length));
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(Math.random() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, n);
}

/**
 * Random sample of `count` questions from the given categories (a name, a list, or empty for all), of the given
 * types (empty or missing for every type).
 */
export async function pickRandom(categories, count, types) {
  const wanted = new Set([categories ?? []].flat().filter(Boolean));
  const kinds = new Set(types ?? []);
  const matching = (list) => list.filter((q) => (!wanted.size || wanted.has(q.category)) && (!kinds.size || kinds.has(typeOf(q))));
  let pool = matching(await listQuestions());
  // Writes only clear the cache of the container that made them: questions an admin just added through the API
  // aren't in this container's copy yet. Re-read before handing out fewer questions than asked for.
  if (pool.length < count) pool = matching(await listQuestions({ fresh: true }));
  return sample(pool, count).map(mapQuestion);
}

export async function createQuestion(data, userId) {
  const item = { id: crypto.randomUUID(), ...cleanQuestion(data), createdBy: userId, createdAt: nowIso() };
  await changing(() => ddb.send(new PutCommand({ TableName: env.questionsTable, Item: item })));
  return mapQuestion(item);
}

export async function updateQuestion(id, data) {
  const res = await ddb.send(new GetCommand({ TableName: env.questionsTable, Key: { id }, ConsistentRead: true }));
  if (!res.Item) throw new HttpError(404, 'Question not found');
  // A type change must not leave the old type's fields behind (e.g. options on a "type it" question).
  const { id: _id, createdBy, createdAt } = res.Item;
  const item = { id, ...cleanQuestion(data), createdBy, createdAt, updatedAt: nowIso() };
  try {
    await changing(() => ddb.send(new PutCommand({ TableName: env.questionsTable, Item: item, ConditionExpression: 'attribute_exists(id)' })));
  } catch (err) {
    if (isConditionFailed(err)) throw new HttpError(404, 'Question not found');
    throw err;
  }
  return mapQuestion(item);
}

export async function deleteQuestion(id) {
  try {
    await changing(() => ddb.send(new DeleteCommand({ TableName: env.questionsTable, Key: { id }, ConditionExpression: 'attribute_exists(id)' })));
  } catch (err) {
    if (isConditionFailed(err)) throw new HttpError(404, 'Question not found');
    throw err;
  }
}

// BatchWrite may hand back "unprocessed" items under load: retry those with full-jitter backoff, then give up loudly.
async function putBatch(items) {
  let requests = items.map((Item) => ({ PutRequest: { Item } }));
  for (let attempt = 0; requests.length; attempt++) {
    if (attempt === 6) throw new HttpError(503, 'Server busy, please try again.');
    if (attempt) await sleep(Math.random() * Math.min(2000, 100 * 2 ** attempt));
    const res = await ddb.send(new BatchWriteCommand({ RequestItems: { [env.questionsTable]: requests } }));
    requests = res.UnprocessedItems?.[env.questionsTable] || [];
  }
}

/** Insert many questions, skipping ones whose text already exists. Returns how many were added. Safe to retry. */
export async function insertMany(questions, userId) {
  // Dedupe against a fresh read: the cached list may be up to 30 s old.
  const existing = new Set((await listQuestions({ fresh: true })).map((q) => q.text.trim().toLowerCase()));
  const added = [];
  for (const q of questions) {
    const k = q.text.trim().toLowerCase();
    if (existing.has(k)) continue;
    existing.add(k);
    added.push({ id: crypto.randomUUID(), ...cleanQuestion(q), createdBy: userId ?? null, createdAt: nowIso() });
  }
  await changing(async () => {
    for (let i = 0; i < added.length; i += 25) await putBatch(added.slice(i, i + 25));
  });
  return added.length;
}
