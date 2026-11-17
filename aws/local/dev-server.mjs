// Local stand-in for API Gateway, so the REAL Lambda handlers can be run and tested without AWS:
//   - DynamoDB Local (Docker) instead of DynamoDB
//   - this HTTP server instead of the HTTP API   (/api/* -> handlers/http.js)
//   - a `ws` WebSocket server instead of the WebSocket API ($connect / $default / $disconnect)
//   - the GameTimer Lambda is called in-process instead of via Lambda.Invoke
//   - public/ is served like the S3 website, with a config.js pointing at this server
//
// Usage:  docker run -d -p 8000:8000 --name quibble-dynamodb amazon/dynamodb-local
//         npm run dev                -> http://localhost:5050
import 'dotenv/config';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { WebSocketServer } from 'ws';
import { DynamoDBClient, CreateTableCommand, ListTablesCommand } from '@aws-sdk/client-dynamodb';
import { ROOT_DIR } from '../scripts/stack.mjs';
import { QUESTIONS } from '../scripts/questions.js';

const PORT = Number(process.env.LOCAL_PORT) || 5050;
const DDB = process.env.DYNAMODB_ENDPOINT || 'http://localhost:8000';
const PREFIX = process.env.LOCAL_TABLE_PREFIX || 'quibble-local-';

Object.assign(process.env, {
  QUIBBLE_LOCAL: '1',
  DYNAMODB_ENDPOINT: DDB,
  AWS_REGION: 'local',
  USERS_TABLE: `${PREFIX}users`,
  QUESTIONS_TABLE: `${PREFIX}questions`,
  GAMES_TABLE: `${PREFIX}games`,
  CONNECTIONS_TABLE: `${PREFIX}connections`,
  RESULTS_TABLE: `${PREFIX}results`,
  RATE_LIMITS_TABLE: `${PREFIX}rate-limits`,
  JWT_SECRET: process.env.LOCAL_JWT_SECRET || 'local-dev-only-secret-0123456789abcdef0123456789',
  WS_ENDPOINT: 'http://local',
  TIMER_FUNCTION: 'local-timer',
  REVEAL_MS: process.env.REVEAL_MS || '4000',
  AUTH_RATE_MAX: process.env.AUTH_RATE_MAX || '1000',
});

// ---------- tables (same keys / indexes as template.yaml) ----------
const S = (n) => ({ AttributeName: n, AttributeType: 'S' });
const H = (n) => ({ AttributeName: n, KeyType: 'HASH' });
const TABLES = [
  { TableName: process.env.USERS_TABLE, AttributeDefinitions: [S('pk')], KeySchema: [H('pk')] },
  { TableName: process.env.QUESTIONS_TABLE, AttributeDefinitions: [S('id')], KeySchema: [H('id')] },
  { TableName: process.env.GAMES_TABLE, AttributeDefinitions: [S('code')], KeySchema: [H('code')] },
  {
    TableName: process.env.CONNECTIONS_TABLE,
    AttributeDefinitions: [S('connectionId'), S('userId'), S('gameCode')],
    KeySchema: [H('connectionId')],
    GlobalSecondaryIndexes: [
      { IndexName: 'byUser', KeySchema: [H('userId')], Projection: { ProjectionType: 'ALL' } },
      { IndexName: 'byGame', KeySchema: [H('gameCode')], Projection: { ProjectionType: 'ALL' } },
    ],
  },
  { TableName: process.env.RESULTS_TABLE, AttributeDefinitions: [S('userId'), S('sk')], KeySchema: [H('userId'), { AttributeName: 'sk', KeyType: 'RANGE' }] },
  { TableName: process.env.RATE_LIMITS_TABLE, AttributeDefinitions: [S('key')], KeySchema: [H('key')] },
];

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
  }
}

// ---------- load the real handlers ----------
const backend = path.join(ROOT_DIR, 'aws', 'backend', 'src');
const imp = (p) => import(new URL(`file:///${path.join(backend, p).replace(/\\/g, '/')}`).href);
const httpFn = (await imp('handlers/http.js')).handler;
const connectFn = (await imp('handlers/wsConnect.js')).handler;
const disconnectFn = (await imp('handlers/wsDisconnect.js')).handler;
const messageFn = (await imp('handlers/wsMessage.js')).handler;
const timerFn = (await imp('handlers/gameTimer.js')).handler;

// ---------- seed (idempotent) ----------
{
  const { upsertAdmin, getUserByEmail } = await imp('lib/users.js');
  const { insertMany } = await imp('lib/questions.js');
  const email = process.env.ADMIN_EMAIL || 'admin@example.com';
  let admin = await getUserByEmail(email);
  if (!admin) {
    const password = process.env.ADMIN_PASSWORD || 'admin12345';
    admin = (await upsertAdmin({ email, username: process.env.ADMIN_USERNAME || 'admin', passwordHash: await bcrypt.hash(password, 10) })).user;
    console.log(`seeded admin ${email} / ${password}`);
  }
  const added = await insertMany(QUESTIONS.map(([text, options, correctIndex, category, timeLimit]) => ({ text, options, correctIndex, category, timeLimit })), admin.id);
  if (added) console.log(`seeded ${added} questions`);
}

// ---------- fake API Gateway Management API + Lambda.Invoke ----------
const sockets = new Map(); // connectionId -> ws
globalThis.__QUIBBLE_LOCAL__ = {
  async send(connectionId, data) {
    const ws = sockets.get(connectionId);
    if (!ws || ws.readyState !== ws.OPEN) {
      const err = new Error('Gone');
      err.name = 'GoneException';
      throw err;
    }
    ws.send(data);
  },
  async close(connectionId) {
    sockets.get(connectionId)?.close(1008, 'kicked');
  },
  schedule(payload) {
    // Like an async Lambda invoke: don't wait for it.
    timerFn(payload).catch((err) => console.error('timer failed', err));
  },
};

// ---------- HTTP: /api -> Lambda, everything else -> static files (like S3) ----------
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
const publicDir = path.join(ROOT_DIR, 'public');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith('/api/')) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const event = {
      version: '2.0',
      rawPath: url.pathname,
      rawQueryString: url.search.slice(1),
      queryStringParameters: Object.fromEntries(url.searchParams),
      headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), String(v)])),
      body: chunks.length ? Buffer.concat(chunks).toString('utf8') : undefined,
      isBase64Encoded: false,
      requestContext: { http: { method: req.method, path: url.pathname, sourceIp: req.socket.remoteAddress }, requestId: crypto.randomUUID() },
    };
    const out = await httpFn(event);
    res.writeHead(out.statusCode, out.headers);
    return res.end(out.body);
  }
  if (url.pathname === '/config.js') {
    res.writeHead(200, { 'content-type': 'text/javascript' });
    return res.end(`window.QUIBBLE_CONFIG = ${JSON.stringify({ apiUrl: '', wsUrl: `ws://${req.headers.host}/ws` })};\n`);
  }
  let file = path.normalize(path.join(publicDir, decodeURIComponent(url.pathname)));
  if (!file.startsWith(publicDir)) { res.writeHead(403); return res.end(); }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file)) file = path.join(publicDir, 'index.html'); // S3 ErrorDocument
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
});

// ---------- WebSocket: same lifecycle as API Gateway ----------
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', async (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname !== '/ws') return socket.destroy();
  const connectionId = crypto.randomBytes(9).toString('base64url');
  const ctx = (routeKey) => ({ requestContext: { routeKey, connectionId } });
  const r = await connectFn({ ...ctx('$connect'), queryStringParameters: Object.fromEntries(url.searchParams) });
  if (r.statusCode !== 200) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    sockets.set(connectionId, ws);
    // API Gateway runs one Lambda per message concurrently; so do we (no awaiting in order).
    ws.on('message', (data) => messageFn({ ...ctx('$default'), body: data.toString() }).catch((e) => console.error(e)));
    ws.on('close', () => {
      sockets.delete(connectionId);
      disconnectFn(ctx('$disconnect')).catch((e) => console.error(e));
    });
  });
});

server.listen(PORT, () => console.log(`Quibble (local AWS emulation) on http://localhost:${PORT}`));
