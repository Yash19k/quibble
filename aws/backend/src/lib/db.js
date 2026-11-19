import http from 'node:http';
import https from 'node:https';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

// DYNAMODB_ENDPOINT is only set by the local dev server (DynamoDB Local in Docker).
const local = process.env.DYNAMODB_ENDPOINT;

// One Lambda may fan out hundreds of requests at once (e.g. pushing a result to 250 players), so keep
// connections alive and allow plenty of parallel sockets instead of the default 50.
const agentOptions = { keepAlive: true, maxSockets: 256 };
export const httpAgents = { httpAgent: new http.Agent(agentOptions), httpsAgent: new https.Agent(agentOptions) };

const client = new DynamoDBClient({
  ...(local ? { endpoint: local, region: 'local', credentials: { accessKeyId: 'local', secretAccessKey: 'local' } } : {}),
  requestHandler: httpAgents,
  maxAttempts: 6, // throttling and transient errors are retried with backoff by the SDK
});

export const ddb = DynamoDBDocumentClient.from(client, {
  marshallOptions: { removeUndefinedValues: true, convertClassInstanceToMap: true },
});

// ---------- optional capacity tracking (local load tests) ----------
// With QUIBBLE_TRACK_CAPACITY=1 every request asks DynamoDB for its consumed capacity. Usage is summed per second
// per table AND per partition-key value, so the load test can check every key stays far below DynamoDB's
// per-partition limits (1,000 WCU/s and 3,000 RCU/s) - limits DynamoDB Local itself doesn't enforce.
const KEY_ATTRS = ['pk', 'code', 'connectionId', 'userId', 'id', 'key'];
const usage = new Map(); // second -> Map("table|key" -> { read, write })

function partitionKeyOf(input) {
  const item = input?.Key || input?.Item;
  if (item) {
    for (const a of KEY_ATTRS) if (item[a] !== undefined) return String(item[a]);
  }
  const kce = input?.KeyConditionExpression;
  if (kce) {
    const m = /^\s*(#?\w+)\s*=\s*(:\w+)/.exec(kce);
    if (m && input.ExpressionAttributeValues?.[m[2]] !== undefined) return String(input.ExpressionAttributeValues[m[2]]);
  }
  return '(multi)'; // scans, batches and transactions span several keys
}

function addUsage(sec, label, read, write) {
  if (!usage.has(sec)) usage.set(sec, new Map());
  const row = usage.get(sec).get(label) || { read: 0, write: 0 };
  row.read += read;
  row.write += write;
  usage.get(sec).set(label, row);
}

if (process.env.QUIBBLE_TRACK_CAPACITY) {
  ddb.middlewareStack.add(
    (next, context) => async (args) => {
      if (args.input && typeof args.input === 'object' && !args.input.ReturnConsumedCapacity) {
        args.input.ReturnConsumedCapacity = 'TOTAL';
      }
      const out = await next(args);
      const isRead = /Get|Query|Scan/.test(context?.commandName || '');
      const pk = partitionKeyOf(args.input);
      const sec = Math.floor(Date.now() / 1000);
      for (const c of [out.output?.ConsumedCapacity ?? []].flat()) {
        if (!c?.TableName) continue;
        let read = c.ReadCapacityUnits ?? 0;
        let write = c.WriteCapacityUnits ?? 0;
        if (!read && !write) {
          if (isRead) read = c.CapacityUnits ?? 0;
          else write = c.CapacityUnits ?? 0;
        }
        addUsage(sec, `${c.TableName}|*`, read, write);
        addUsage(sec, `${c.TableName}|${pk}`, read, write);
      }
      return out;
    },
    { step: 'initialize', name: 'quibbleCapacityTracker' }
  );
}

/**
 * Consumed capacity since the last reset: per table (all keys) and the busiest partition keys, each with its
 * peak read/write units in any single second. Local load tests only.
 */
export function capacityReport({ reset = false, top = 10 } = {}) {
  const peaks = new Map(); // label -> { peakReadPerSec, peakWritePerSec, totalRead, totalWrite }
  for (const [, perLabel] of usage) {
    for (const [label, { read, write }] of perLabel) {
      const p = peaks.get(label) || { peakReadPerSec: 0, peakWritePerSec: 0, totalRead: 0, totalWrite: 0 };
      p.peakReadPerSec = Math.max(p.peakReadPerSec, read);
      p.peakWritePerSec = Math.max(p.peakWritePerSec, write);
      p.totalRead += read;
      p.totalWrite += write;
      peaks.set(label, p);
    }
  }
  const round = (p) => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, Math.round(v * 10) / 10]));
  const tables = {};
  const keys = [];
  for (const [label, p] of peaks) {
    const [table, key] = label.split('|');
    if (key === '*') tables[table] = round(p);
    else if (key !== '(multi)') keys.push({ table, key, ...round(p) });
  }
  const busiest = (field) => [...keys].sort((a, b) => b[field] - a[field]).slice(0, top);
  if (reset) usage.clear();
  return {
    enabled: !!process.env.QUIBBLE_TRACK_CAPACITY,
    limitsPerPartition: { readPerSec: 3000, writePerSec: 1000 },
    tables,
    busiestWriteKeys: busiest('peakWritePerSec'),
    busiestReadKeys: busiest('peakReadPerSec'),
  };
}

/** Scan a whole table (follows pagination). Fine for the small tables this app uses. */
export async function scanAll(params) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const res = await ddb.send(new ScanCommand({ ...params, ExclusiveStartKey }));
    items.push(...(res.Items || []));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

/** Query and follow pagination. */
export async function queryAll(params) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const res = await ddb.send(new QueryCommand({ ...params, ExclusiveStartKey }));
    items.push(...(res.Items || []));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

export const isConditionFailed = (err) =>
  err?.name === 'ConditionalCheckFailedException' || err?.name === 'TransactionCanceledException';

export const nowIso = () => new Date().toISOString();
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
