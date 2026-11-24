// Local stand-in for API Gateway + Lambda, so the REAL Lambda handlers can be run and tested without AWS:
//   - DynamoDB Local (Docker) instead of DynamoDB
//   - this HTTP server instead of the HTTP API   (/api/* -> handlers/http.js)
//   - a `ws` WebSocket server instead of the WebSocket API ($connect / $default / $disconnect)
//   - the GameTimer Lambda runs in-process, queued like an async Lambda.Invoke
//   - public/ is served like the S3 site, with a config.js pointing at this server
//
// Optional AWS failure emulation (documented in .env.example):
//   LOCAL_LAMBDA_CONCURRENCY=10   at most this many handler runs at once, across ALL functions (the account's Lambda
//                                 concurrency quota). Extra invocations fail exactly the way API Gateway / Lambda fail.
//   LOCAL_DROP_DISCONNECT_PCT=15  silently skip this % of $disconnect events (API Gateway's are best-effort)
//   LOCAL_TRACK_CAPACITY=1        record DynamoDB capacity per partition key -> GET /__local/capacity[?reset=1]
//   LOCAL_SWEEP_MS=120000         how often the abandoned-game sweep runs (the EventBridge schedule on AWS); 0 = never
// GET /__local/stats[?reset=1] reports invocations, throttles, dropped disconnects and timer re-queues.
// Always on: API Gateway's 128 KB WebSocket message limit (both directions); events carry requestTimeEpoch/timeEpoch.
//
// Usage:  docker run -d -p 8000:8000 --name quibble-dynamodb amazon/dynamodb-local
//         npm run dev                -> http://localhost:5050
import 'dotenv/config';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import bcrypt from 'bcryptjs';
import { WebSocketServer } from 'ws';
import { DynamoDBClient, CreateTableCommand, DescribeTableCommand, ListTablesCommand } from '@aws-sdk/client-dynamodb';
import { ROOT_DIR } from '../scripts/stack.mjs';
import { seedQuestions } from '../scripts/questions.js';

const PORT = Number(process.env.LOCAL_PORT) || 5050;
const DDB = process.env.DYNAMODB_ENDPOINT || 'http://localhost:8000';
const PREFIX = process.env.LOCAL_TABLE_PREFIX || 'quibble-local-';
const CONCURRENCY = Math.max(0, Math.floor(Number(process.env.LOCAL_LAMBDA_CONCURRENCY) || 0)); // 0 = unlimited
const DROP_DISCONNECT_PCT = Math.min(100, Math.max(0, Number(process.env.LOCAL_DROP_DISCONNECT_PCT) || 0));
const TRACK_CAPACITY = /^(1|true|yes|on)$/i.test(process.env.LOCAL_TRACK_CAPACITY || '');
const SWEEP_MS = Math.max(0, Number(process.env.LOCAL_SWEEP_MS ?? 120_000) || 0);

// Environment the handlers read (lib/config.js). Values from the shell or .env win over these local defaults.
const orDefault = (name, value) => process.env[name] || value;
Object.assign(process.env, {
  QUIBBLE_LOCAL: '1',
  DYNAMODB_ENDPOINT: DDB,
  AWS_REGION: 'local',
  USERS_TABLE: `${PREFIX}users`,
  QUESTIONS_TABLE: `${PREFIX}questions`,
  GAMES_TABLE: `${PREFIX}games`,
  GAMEPLAY_TABLE: `${PREFIX}gameplay`,
  CONNECTIONS_TABLE: `${PREFIX}connections`,
  RESULTS_TABLE: `${PREFIX}results`,
  RATE_LIMITS_TABLE: `${PREFIX}rate-limits`,
  QUIZZES_TABLE: `${PREFIX}quizzes`,
  ADMIN_TABLE: `${PREFIX}admin`,
  JWT_SECRET: process.env.LOCAL_JWT_SECRET || 'local-dev-only-secret-0123456789abcdef0123456789',
  WS_ENDPOINT: 'http://local',
  TIMER_FUNCTION: 'local-timer',
  REVEAL_MS: orDefault('REVEAL_MS', '4000'),
  // Every request comes from 127.0.0.1, and load tests sign up hundreds of users run after run: be generous.
  REGISTER_MAX_PER_IP: orDefault('REGISTER_MAX_PER_IP', '100000'),
  LOGIN_FAIL_MAX_PER_IP: orDefault('LOGIN_FAIL_MAX_PER_IP', '100000'),
  LOGIN_FAIL_MAX_PER_EMAIL: orDefault('LOGIN_FAIL_MAX_PER_EMAIL', '1000'),
  // lib/db.js decides at import time whether to measure consumed capacity, so this must be set before any handler loads.
  ...(TRACK_CAPACITY ? { QUIBBLE_TRACK_CAPACITY: '1' } : {}),
});
// LATE_GRACE_MS, MAX_PLAYERS and BROADCAST_WINDOW_MS pass straight through; unset = the same defaults as on AWS.
const PASSTHROUGH = ['REVEAL_MS', 'LATE_GRACE_MS', 'MAX_PLAYERS', 'BROADCAST_WINDOW_MS', 'REGISTER_MAX_PER_IP',
  'LOGIN_FAIL_MAX_PER_IP', 'LOGIN_FAIL_MAX_PER_EMAIL'];

// ---------- tables (same keys / indexes as template.yaml) ----------
const S = (n) => ({ AttributeName: n, AttributeType: 'S' });
const H = (n) => ({ AttributeName: n, KeyType: 'HASH' });
const R = (n) => ({ AttributeName: n, KeyType: 'RANGE' });
const TABLES = [
  { TableName: process.env.USERS_TABLE, AttributeDefinitions: [S('pk')], KeySchema: [H('pk')] },
  { TableName: process.env.QUESTIONS_TABLE, AttributeDefinitions: [S('id')], KeySchema: [H('id')] },
  { TableName: process.env.GAMES_TABLE, AttributeDefinitions: [S('code')], KeySchema: [H('code')] },
  { TableName: process.env.GAMEPLAY_TABLE, AttributeDefinitions: [S('pk'), S('sk')], KeySchema: [H('pk'), R('sk')] },
  {
    TableName: process.env.CONNECTIONS_TABLE,
    AttributeDefinitions: [S('connectionId'), S('userId')],
    KeySchema: [H('connectionId')],
    GlobalSecondaryIndexes: [{ IndexName: 'byUser', KeySchema: [H('userId')], Projection: { ProjectionType: 'ALL' } }],
  },
  { TableName: process.env.RESULTS_TABLE, AttributeDefinitions: [S('userId'), S('sk')], KeySchema: [H('userId'), R('sk')] },
  { TableName: process.env.RATE_LIMITS_TABLE, AttributeDefinitions: [S('key')], KeySchema: [H('key')] },
  { TableName: process.env.ADMIN_TABLE, AttributeDefinitions: [S('pk'), S('sk')], KeySchema: [H('pk'), R('sk')] },
  {
    TableName: process.env.QUIZZES_TABLE,
    AttributeDefinitions: [S('id'), S('ownerId'), S('updatedAt')],
    KeySchema: [H('id')],
    GlobalSecondaryIndexes: [{ IndexName: 'byOwner', KeySchema: [H('ownerId'), R('updatedAt')], Projection: { ProjectionType: 'ALL' } }],
  },
];

// Keys + index names: enough to spot a table left over from an older schema.
const shapeOf = (t) => JSON.stringify([
  t.KeySchema.map((k) => `${k.AttributeName}:${k.KeyType}`),
  (t.GlobalSecondaryIndexes || []).map((i) => i.IndexName).sort(),
]);

const raw = new DynamoDBClient({ endpoint: DDB, region: 'local', credentials: { accessKeyId: 'local', secretAccessKey: 'local' } });
let existing;
try {
  existing = new Set((await raw.send(new ListTablesCommand({}))).TableNames);
} catch {
  console.error(`Can't reach DynamoDB Local at ${DDB}. Start it with:\n  docker run -d -p 8000:8000 --name quibble-dynamodb amazon/dynamodb-local`);
  process.exit(1);
}
for (const t of TABLES) {
  if (!existing.has(t.TableName)) {
    await raw.send(new CreateTableCommand({ ...t, BillingMode: 'PAY_PER_REQUEST' }));
    console.log(`created table ${t.TableName}`);
    continue;
  }
  const { Table } = await raw.send(new DescribeTableCommand({ TableName: t.TableName }));
  if (shapeOf(Table) !== shapeOf(t)) {
    console.warn(`! table ${t.TableName} has an older schema. To start fresh (wipes local data): docker restart quibble-dynamodb`);
  }
}

// ---------- Lambda emulation: one concurrency pool shared by every function ----------
let handlers; // filled in below, once the fake AWS transport is installed
// Timeouts from template.yaml. Locally a slow run isn't killed, only reported.
const TIMEOUT_MS = { http: 20_000, connect: 15_000, message: 15_000, disconnect: 15_000, timer: 120_000 };
const FUNCTIONS = Object.keys(TIMEOUT_MS);
const perFunction = () => Object.fromEntries(FUNCTIONS.map((f) => [f, 0]));

let inFlight = 0;
let stats;
function resetStats() {
  stats = {
    since: new Date().toISOString(),
    peakInFlight: inFlight,
    invocations: perFunction(),
    throttles: perFunction(), // invocations refused because LOCAL_LAMBDA_CONCURRENCY slots were all busy
    errors: perFunction(), // handler threw (or rejected)
    slowRuns: perFunction(), // ran longer than the function's Lambda timeout
    timer: { requeued: 0, retried: 0, dropped: 0 },
    disconnectsDropped: { random: 0, throttled: 0 },
    pushes: { sent: 0, gone: 0, tooLarge: 0 },
  };
}
resetStats();

const lambdaContext = (name, started) => ({
  functionName: `local-${name}`,
  awsRequestId: crypto.randomUUID(),
  getRemainingTimeInMillis: () => Math.max(0, started + TIMEOUT_MS[name] - Date.now()),
  callbackWaitsForEmptyEventLoop: true,
});

/**
 * Runs a handler the way Lambda would: only when a concurrency slot is free (a slot stays busy until the handler's
 * promise settles, deferred work included). Returns null when throttled - each caller then fails like AWS does.
 */
function tryInvoke(name, event) {
  if (CONCURRENCY && inFlight >= CONCURRENCY) {
    stats.throttles[name]++;
    return null;
  }
  inFlight++;
  stats.peakInFlight = Math.max(stats.peakInFlight, inFlight);
  stats.invocations[name]++;
  const started = Date.now();
  return Promise.resolve()
    .then(() => handlers[name](event, lambdaContext(name, started)))
    .catch((err) => {
      stats.errors[name]++;
      throw err;
    })
    .finally(() => {
      inFlight--;
      const ms = Date.now() - started;
      if (ms > TIMEOUT_MS[name]) {
        stats.slowRuns[name]++;
        console.warn(`! ${name} handler ran ${ms} ms; on AWS it would have timed out after ${TIMEOUT_MS[name]} ms`);
      }
    });
}

// Async invoke (InvocationType 'Event'): Lambda queues the event and returns at once. A throttled event goes back on
// the queue with backoff (1, 2, 4 ... s, capped at 30 s here) until it is MaximumEventAgeInSeconds old, then it is
// dropped. A run that throws is retried MaximumRetryAttempts times, 1 and then 2 minutes later.
const MAX_EVENT_AGE_MS = 600_000;
const RETRY_DELAYS_MS = [60_000, 120_000];

function invokeAsync(payload) {
  const event = JSON.parse(JSON.stringify(payload ?? {})); // it travels as JSON on AWS too
  const queuedAt = Date.now();
  const attempt = (throttled, retries) => {
    const run = tryInvoke('timer', event);
    if (!run) {
      if (Date.now() - queuedAt >= MAX_EVENT_AGE_MS) {
        stats.timer.dropped++;
        console.warn('! game timer event dropped (too old)', event);
        return;
      }
      stats.timer.requeued++;
      setTimeout(() => attempt(throttled + 1, retries), Math.min(30_000, 1000 * 2 ** throttled));
      return;
    }
    run.catch((err) => {
      console.error('game timer failed', err);
      if (retries >= RETRY_DELAYS_MS.length || Date.now() - queuedAt >= MAX_EVENT_AGE_MS) {
        stats.timer.dropped++;
        return;
      }
      stats.timer.retried++;
      setTimeout(() => attempt(0, retries + 1), RETRY_DELAYS_MS[retries]);
    });
  };
  setImmediate(() => attempt(0, 0)); // the caller's Invoke returns before the timer starts
}

// ---------- fake API Gateway Management API + Lambda.Invoke (used by lib/push.js and lib/timer.js) ----------
// Installed before the handlers are imported, so no module can ever see it missing.
const MAX_MESSAGE_BYTES = 128 * 1024; // API Gateway WebSocket message limit, in both directions
const sockets = new Map(); // connectionId -> ws
const gone = () => Object.assign(new Error('Gone'), { name: 'GoneException', $metadata: { httpStatusCode: 410 } });
globalThis.__QUIBBLE_LOCAL__ = {
  // PostToConnection
  async send(connectionId, data) {
    const ws = sockets.get(connectionId);
    if (!ws || ws.readyState !== ws.OPEN) {
      stats.pushes.gone++;
      throw gone();
    }
    const bytes = Buffer.byteLength(data);
    if (bytes > MAX_MESSAGE_BYTES) {
      stats.pushes.tooLarge++;
      console.warn(`! a ${bytes}-byte push was refused: API Gateway allows ${MAX_MESSAGE_BYTES} bytes per message`);
      throw Object.assign(new Error(`Message too large (${bytes} bytes)`), {
        name: 'PayloadTooLargeException',
        $metadata: { httpStatusCode: 413 },
      });
    }
    ws.send(typeof data === 'string' ? data : Buffer.from(data));
    stats.pushes.sent++;
  },
  // DeleteConnection (fires $disconnect, like on AWS)
  async close(connectionId) {
    const ws = sockets.get(connectionId);
    if (!ws) throw gone();
    ws.close(1008, 'kicked');
  },
  // Lambda Invoke with InvocationType 'Event': returns at once, the timer runs later
  async schedule(payload) {
    invokeAsync(payload);
  },
};

// ---------- load the real handlers ----------
const backend = path.join(ROOT_DIR, 'aws', 'backend', 'src');
// One URL per file, so these share module instances (db.js capacity counters, caches) with the handlers' own imports.
const imp = (p) => import(pathToFileURL(path.join(backend, p)).href);
handlers = {
  http: (await imp('handlers/http.js')).handler,
  connect: (await imp('handlers/wsConnect.js')).handler,
  disconnect: (await imp('handlers/wsDisconnect.js')).handler,
  message: (await imp('handlers/wsMessage.js')).handler,
  timer: (await imp('handlers/gameTimer.js')).handler,
};
const { capacityReport } = await imp('lib/db.js');
const images = await imp('lib/images.js');

// ---------- seed (idempotent) ----------
{
  const { upsertAdmin, getUserByEmail } = await imp('lib/users.js');
  const { insertMany } = await imp('lib/questions.js');
  const email = process.env.ADMIN_EMAIL || 'admin@example.com';
  let admin = await getUserByEmail(email, { consistent: true });
  if (!admin) {
    const password = process.env.ADMIN_PASSWORD || 'admin12345';
    admin = (await upsertAdmin({ email, username: process.env.ADMIN_USERNAME || 'admin', passwordHash: await bcrypt.hash(password, 10) })).user;
    console.log(`seeded admin ${email} / ${password}`);
  }
  const added = await insertMany(seedQuestions(), admin.id);
  if (added) console.log(`seeded ${added} questions`);
}

// ---------- HTTP: /api -> Lambda, /__local -> emulator info, everything else -> static files (like S3) ----------
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};
const publicDir = path.join(ROOT_DIR, 'public');
const clientIp = (req) => String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

// HTTP API payload format 2.0.
async function handleApi(req, res, url) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const requestId = crypto.randomUUID();
  const now = Date.now();
  const event = {
    version: '2.0',
    routeKey: 'ANY /api/{proxy+}',
    rawPath: url.pathname,
    rawQueryString: url.search.slice(1),
    headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), String(v)])),
    queryStringParameters: url.search.length > 1 ? Object.fromEntries(url.searchParams) : undefined,
    pathParameters: { proxy: url.pathname.slice('/api/'.length) },
    body: chunks.length ? Buffer.concat(chunks).toString('utf8') : undefined,
    isBase64Encoded: false,
    requestContext: {
      accountId: 'local',
      apiId: 'local',
      domainName: req.headers.host,
      stage: '$default',
      routeKey: 'ANY /api/{proxy+}',
      requestId,
      http: { method: req.method, path: url.pathname, protocol: `HTTP/${req.httpVersion}`, sourceIp: clientIp(req), userAgent: req.headers['user-agent'] || '' },
      time: new Date(now).toISOString(),
      timeEpoch: now, // when API Gateway received the request
    },
  };
  let out;
  const run = tryInvoke('http', event);
  if (run) {
    try {
      out = await run;
    } catch (err) {
      console.error('api handler failed', err);
    }
  }
  // A throttled or crashed Lambda: API Gateway answers 500 with its own body (and never retries).
  if (!out) return sendJson(res, 500, { message: 'Internal Server Error' }, { 'apigw-requestid': requestId });
  if (typeof out !== 'object' || !out.statusCode) out = { statusCode: 200, body: JSON.stringify(out) };
  const headers = { ...out.headers, 'apigw-requestid': requestId };
  if (out.cookies?.length) headers['set-cookie'] = out.cookies;
  res.writeHead(out.statusCode, headers);
  res.end(out.isBase64Encoded ? Buffer.from(out.body || '', 'base64') : out.body);
}

function handleLocal(res, url) {
  const reset = ['1', 'true', 'yes'].includes(url.searchParams.get('reset'));
  if (url.pathname === '/__local/capacity') {
    return sendJson(res, 200, capacityReport({ reset, top: Number(url.searchParams.get('top')) || undefined }));
  }
  if (url.pathname === '/__local/stats') {
    const body = { concurrencyLimit: CONCURRENCY || null, inFlight, dropDisconnectPct: DROP_DISCONNECT_PCT, ...stats };
    if (reset) resetStats();
    return sendJson(res, 200, body);
  }
  return sendJson(res, 404, { error: 'Not found' });
}

let aliasMap = null; // alias -> { file, name } for public/flags/<name>.svg
function flagAliases() {
  if (aliasMap) return aliasMap;
  aliasMap = new Map();
  const dir = path.join(publicDir, 'flags');
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const m = /^([a-z0-9-]+)\.svg$/i.exec(f);
    if (m) aliasMap.set(images.imageAlias(m[1]), { file: path.join(dir, f), name: m[1] });
  }
  return aliasMap;
}

function serveStatic(res, url) {
  let rel;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400);
    return res.end();
  }
  if (rel === '/') rel = '/index.html'; // like the S3 website's index document
  // Games show flags under their per-deploy alias (lib/images.js), like the files the publish step uploads.
  const alias = /^\/flags\/([A-Za-z0-9_-]+)\.svg$/.exec(rel);
  if (alias && flagAliases().has(alias[1])) {
    const { file, name } = flagAliases().get(alias[1]);
    res.writeHead(200, { 'content-type': TYPES['.svg'], 'cache-control': 'no-cache' });
    return res.end(images.aliasedSvg(fs.readFileSync(file, 'utf8'), name));
  }
  const file = path.normalize(path.join(publicDir, rel));
  if (!file.startsWith(publicDir + path.sep)) {
    res.writeHead(403);
    return res.end();
  }
  // Players use S3's HTTPS endpoint, which has no index/error documents: a missing file is an error there too.
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('Not found');
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (url.pathname.startsWith('/__local/')) return handleLocal(res, url);
    if (url.pathname === '/config.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' });
      return res.end(`window.QUIBBLE_CONFIG = ${JSON.stringify({ apiUrl: '', wsUrl: `ws://${req.headers.host}/ws` })};\n`);
    }
    return serveStatic(res, url);
  } catch (err) {
    console.error('request failed', err);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});

// ---------- WebSocket: same lifecycle and failure modes as API Gateway ----------
// A bigger client message closes the socket with 1009, as API Gateway does.
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

server.on('upgrade', (req, socket, head) => {
  onUpgrade(req, socket, head).catch((err) => {
    console.error('websocket upgrade failed', err);
    socket.destroy();
  });
});

async function onUpgrade(req, socket, head) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname !== '/ws') return socket.destroy();
  const connectionId = crypto.randomBytes(9).toString('base64url');
  const connectedAt = Date.now();
  const wsEvent = (routeKey, eventType, extra = {}, context = {}) => ({
    requestContext: {
      routeKey,
      eventType,
      connectionId,
      connectedAt,
      requestId: crypto.randomUUID(),
      requestTimeEpoch: Date.now(), // when API Gateway received the frame: the game times answers by this
      domainName: req.headers.host,
      stage: 'local',
      apiId: 'local',
      identity: { sourceIp: clientIp(req) },
      ...context,
    },
    isBase64Encoded: false,
    ...extra,
  });

  // $connect: a throttled or crashed Lambda fails the handshake (browsers see close code 1006).
  let status = 500;
  const run = tryInvoke('connect', wsEvent('$connect', 'CONNECT', {
    headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), String(v)])),
    queryStringParameters: url.search.length > 1 ? Object.fromEntries(url.searchParams) : undefined,
  }));
  if (run) {
    try {
      status = (await run)?.statusCode ?? 200;
    } catch (err) {
      console.error('$connect failed', err);
    }
  }
  if (status < 200 || status > 299) {
    socket.write(`HTTP/1.1 ${status} ${http.STATUS_CODES[status] || 'Error'}\r\nConnection: close\r\n\r\n`);
    return socket.destroy();
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    sockets.set(connectionId, ws);

    // $default: API Gateway runs one Lambda per frame, concurrently, in no particular order; so do we.
    ws.on('message', (data) => {
      const event = wsEvent('$default', 'MESSAGE', { body: data.toString() }, { messageId: crypto.randomBytes(9).toString('base64url') });
      // A throttled or crashed Lambda: API Gateway sends this frame (no "type", no client id) to the socket.
      const fail = () => {
        if (ws.readyState !== ws.OPEN) return;
        ws.send(JSON.stringify({ message: 'Internal server error', connectionId, requestId: event.requestContext.requestId }));
      };
      const run = tryInvoke('message', event);
      if (!run) return fail();
      run.catch((err) => {
        console.error('$default failed', err);
        fail();
      });
    });

    // $disconnect is best-effort on AWS: it can be dropped (on purpose here) or throttled.
    ws.on('close', (code, reason) => {
      sockets.delete(connectionId);
      if (DROP_DISCONNECT_PCT && Math.random() * 100 < DROP_DISCONNECT_PCT) {
        stats.disconnectsDropped.random++;
        return;
      }
      const run = tryInvoke('disconnect', wsEvent('$disconnect', 'DISCONNECT', {}, {
        disconnectStatusCode: code,
        disconnectReason: reason?.toString() || '',
      }));
      if (!run) {
        stats.disconnectsDropped.throttled++;
        return;
      }
      run.catch((err) => console.error('$disconnect failed', err));
    });
  });
}

server.on('error', (err) => {
  console.error(err.code === 'EADDRINUSE' ? `Port ${PORT} is busy. Set LOCAL_PORT to use another one.` : err);
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`Quibble (local AWS emulation) on http://localhost:${PORT}`);
  const set = PASSTHROUGH.filter((n) => process.env[n]).map((n) => `${n}=${process.env[n]}`);
  if (set.length) console.log(`  settings: ${set.join(' ')}`);
  if (CONCURRENCY) console.log(`  Lambda concurrency limit: ${CONCURRENCY} (extra invocations are throttled like on AWS)`);
  if (DROP_DISCONNECT_PCT) console.log(`  dropping ${DROP_DISCONNECT_PCT}% of $disconnect events`);
  if (TRACK_CAPACITY) console.log(`  DynamoDB capacity tracking on: GET /__local/capacity[?reset=1]`);
  console.log(`  emulator counters: GET /__local/stats[?reset=1]`);
  // Like the template's EventBridge schedule: the GameTimer Lambda gets {kind:'sweep'} every 2 minutes.
  if (SWEEP_MS) setInterval(() => invokeAsync({ kind: 'sweep' }), SWEEP_MS).unref();
});
