// Where a game lives in DynamoDB, and the reads the engine needs (SPEC section 2).
//
//   GamesTable (HASH code): the game header, ~1 KB, rewritten only on phase changes.
//   GamePlayTable (HASH pk, RANGE sk): the items many players write at once. Each item family has its OWN partition
//   key, so a crowd joining or answering spreads over items instead of rewriting one big game item:
//     <code>#M / Q          questions (immutable)          <code>#L / L        lobby gate {open, seq, count, max}
//     <code>#B / B          claims {lobbyDue, unstickUntil} <code>#P / <userId> member {seat, presenter, conns}
//     <code>#Q / <k>        question gate                   <code>#A#<k> / <seat> one answer to question k
//     <code>#S / S          cumulative scores               <code>#R / <k>      result of question k
//   Every GamePlay item carries expiresAt (TTL, ~1 day).
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { ddb, queryAll } from './db.js';
import { env } from './config.js';

// Members are spread over a few partition keys by user id, so a whole room reconnecting at once (every socket's
// presence update) never concentrates on one key.
export const MEMBER_SHARDS = 4;
export function memberShard(userId) {
  let h = 0;
  for (const ch of String(userId)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % MEMBER_SHARDS;
}
const memberPks = (code) => Array.from({ length: MEMBER_SHARDS }, (_, i) => `${code}#P${i}`);

export const keys = {
  meta: (code) => ({ pk: `${code}#M`, sk: 'Q' }),
  lobby: (code) => ({ pk: `${code}#L`, sk: 'L' }),
  claims: (code) => ({ pk: `${code}#B`, sk: 'B' }),
  member: (code, userId) => ({ pk: `${code}#P${memberShard(userId)}`, sk: userId }),
  gate: (code, k) => ({ pk: `${code}#Q`, sk: String(k) }),
  answer: (code, k, seat) => ({ pk: `${code}#A#${k}`, sk: String(seat) }),
  scores: (code) => ({ pk: `${code}#S`, sk: 'S' }),
  result: (code, k) => ({ pk: `${code}#R`, sk: String(k) }),
};

/** TTL value (epoch seconds) `days` from `now`. */
export const ttlAfterDays = (days, now = Date.now()) => Math.floor(now / 1000) + Math.round(days * 86400);

// ---------- expressions ----------
// Every attribute in this engine's expressions is written as #name, and the names map is derived from the expressions
// themselves, so a reserved word (status, count, open, max, total, at...) can never slip through unaliased. Values are
// filtered to the ones the expressions use, because DynamoDB rejects unused ones.
const NAME = /#(\w+)/g;
const VALUE = /:(\w+)/g;

export function expr({ key, update, condition, filter, projection, values } = {}) {
  const parts = { KeyConditionExpression: key, UpdateExpression: update, ConditionExpression: condition, FilterExpression: filter, ProjectionExpression: projection };
  const out = {};
  const names = {};
  const used = new Set();
  for (const [field, text] of Object.entries(parts)) {
    if (!text) continue;
    out[field] = text;
    for (const [, n] of text.matchAll(NAME)) names[`#${n}`] = n;
    for (const [, v] of text.matchAll(VALUE)) used.add(`:${v}`);
  }
  if (Object.keys(names).length) out.ExpressionAttributeNames = names;
  const vals = Object.fromEntries(Object.entries(values ?? {}).filter(([k]) => used.has(k)));
  if (Object.keys(vals).length) out.ExpressionAttributeValues = vals;
  return out;
}

// ---------- errors ----------
const AV_TYPES = new Set(['S', 'N', 'B', 'SS', 'NS', 'BS', 'M', 'L', 'NULL', 'BOOL']);
const isAttributeValue = (v) =>
  !!v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Set) && Object.keys(v).length === 1 && AV_TYPES.has(Object.keys(v)[0]);

/** The DocumentClient only converts successful responses: an error's Item (ALL_OLD on a failed condition, or a
 *  transaction's CancellationReasons[].Item) is still DynamoDB JSON. Returns a plain item, or null. */
export function plain(item) {
  if (!item || typeof item !== 'object') return null;
  const values = Object.values(item);
  return values.length && values.every(isAttributeValue) ? unmarshall(item) : item;
}

export const isCheckFailed = (err) => err?.name === 'ConditionalCheckFailedException';
export const isTxCancelled = (err) => err?.name === 'TransactionCanceledException';
/** One code per transaction item: 'None', 'ConditionalCheckFailed', 'TransactionConflict', 'ThrottlingError', ... */
export const reasonCodes = (err) => (err?.CancellationReasons ?? []).map((r) => r?.Code ?? 'None');

// ---------- reads ----------
async function getItem(TableName, Key, consistent) {
  const res = await ddb.send(new GetCommand({ TableName, Key, ConsistentRead: consistent }));
  return res.Item ?? null;
}

const play = (key, consistent) => getItem(env.gamePlayTable, key, consistent);

export const getHeader = (code, { consistent = true } = {}) => getItem(env.gamesTable, { code }, consistent);
export const getLobby = (code, { consistent = true } = {}) => play(keys.lobby(code), consistent);
export const getClaims = (code, { consistent = true } = {}) => play(keys.claims(code), consistent);
export const getMember = (code, userId, { consistent = true } = {}) => play(keys.member(code, userId), consistent);
export const getGate = (code, k, { consistent = true } = {}) => play(keys.gate(code, k), consistent);
export const getAnswer = (code, k, seat) => play(keys.answer(code, k, seat), true);
export const getScores = (code) => play(keys.scores(code), true);
export const getResult = (code, k) => play(keys.result(code, k), true);

const queryPartition = (pk, consistent) =>
  queryAll({ TableName: env.gamePlayTable, ConsistentRead: consistent, ...expr({ key: '#pk = :pk', values: { ':pk': pk } }) });

/** Every member item (players + the host). Strong by default: fan-out targets and scoring must see the latest. */
export const queryMembers = async (code, { consistent = true } = {}) =>
  (await Promise.all(memberPks(code).map((pk) => queryPartition(pk, consistent)))).flat();
export const queryAnswers = (code, k) => queryPartition(`${code}#A#${k}`, true);

/** Number of players (members that aren't the presenter), strongly consistent. */
export async function countRoster(code) {
  const counts = await Promise.all(memberPks(code).map(async (pk) => {
    let total = 0;
    let ExclusiveStartKey;
    do {
      const res = await ddb.send(new QueryCommand({
        TableName: env.gamePlayTable,
        ConsistentRead: true,
        Select: 'COUNT',
        ExclusiveStartKey,
        ...expr({
          key: '#pk = :pk',
          filter: 'attribute_not_exists(#presenter) OR #presenter <> :t',
          values: { ':pk': pk, ':t': true },
        }),
      }));
      total += res.Count ?? 0;
      ExclusiveStartKey = res.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return total;
  }));
  return counts.reduce((a, b) => a + b, 0);
}

// A game's questions never change, so each container keeps the few games it serves (read once, strongly).
const questionCache = new Map();
const QUESTION_CACHE_SIZE = 100;

export function rememberQuestions(code, questions) {
  if (questionCache.size >= QUESTION_CACHE_SIZE) questionCache.delete(questionCache.keys().next().value);
  questionCache.set(code, questions);
}

export async function getQuestions(code) {
  if (questionCache.has(code)) return questionCache.get(code);
  const item = await play(keys.meta(code), true);
  if (item?.questions) rememberQuestions(code, item.questions);
  return item?.questions ?? null;
}
