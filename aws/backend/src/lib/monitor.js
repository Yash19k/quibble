// The monitor function's logic (handlers/monitor.js wires it to AWS): the uptime probes, and turning CloudWatch alarms
// and CloudFormation deploy failures into readable emails. Everything here is plain functions, so the unit tests run
// it without AWS (aws/tests/monitor.unit.test.mjs).
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { formatTime, siteLink, span, table } from './alerts.js';

// ---------- uptime probes ----------
const secs = (ms) => `${Math.round(ms / 100) / 10} s`;

function fetchFailure(err, timeoutMs) {
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return `no answer within ${secs(timeoutMs)}`;
  return `could not connect (${err?.cause?.code || err?.cause?.message || err?.message || 'unknown error'})`;
}

/** The website (S3): index.html answers 200 with an HTML page. */
export async function checkWebsite(url, timeoutMs = 8000) {
  const started = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' });
    const text = await res.text();
    if (res.status !== 200) return { ok: false, detail: `HTTP ${res.status} ${res.statusText}`.trim() };
    if (!/<html/i.test(text)) return { ok: false, detail: 'HTTP 200 but the page is not HTML' };
    return { ok: true, detail: `HTTP 200 in ${Date.now() - started} ms` };
  } catch (err) {
    return { ok: false, detail: fetchFailure(err, timeoutMs) };
  }
}

/** The REST API: GET /api/health runs the API Lambda and one DynamoDB read, and answers {ok: true, db: 'ok'}. */
export async function checkApi(url, timeoutMs = 8000) {
  const started = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' });
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch { /* not JSON: reported below */ }
    if (res.status !== 200) {
      const why = body?.error || body?.message || text.slice(0, 120);
      return { ok: false, detail: `HTTP ${res.status}${why ? ` (${why})` : ''}` };
    }
    if (!body?.ok) return { ok: false, detail: `HTTP 200 but an unexpected answer: ${text.slice(0, 120)}` };
    if (body.db && body.db !== 'ok') return { ok: false, detail: `database: ${body.db}` };
    return { ok: true, detail: `API and database answered in ${Date.now() - started} ms` };
  } catch (err) {
    return { ok: false, detail: fetchFailure(err, timeoutMs) };
  }
}

/**
 * The WebSocket API: open a handshake without a login token. A healthy stack runs the $connect Lambda, which refuses
 * it with 401. Anything else (5xx from a broken Lambda, 403 from a missing stage, a timeout) is a failure. No socket
 * is ever opened, and nothing is written.
 */
export function checkWebSocket(wssUrl, timeoutMs = 8000) {
  const started = Date.now();
  return new Promise((resolve) => {
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      resolve(result);
    };
    let req;
    try {
      const url = wssUrl.replace(/^ws(s?):/, 'http$1:'); // wss:// -> https:// (ws:// for the tests' local server)
      req = (url.startsWith('https:') ? https : http).request(url, {
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
        },
        timeout: timeoutMs,
      });
    } catch (err) {
      finish({ ok: false, detail: `bad WebSocket URL (${err.message})` });
      return;
    }
    req.on('upgrade', (_res, socket) => {
      socket.destroy();
      finish({ ok: true, detail: `connected in ${Date.now() - started} ms` });
    });
    req.on('response', (res) => {
      res.resume();
      if (res.statusCode === 401) finish({ ok: true, detail: `$connect answered in ${Date.now() - started} ms` });
      else finish({ ok: false, detail: `HTTP ${res.statusCode} ${res.statusMessage ?? ''} (expected 401 for a socket without a login)`.replace(/\s+\(/, ' (') });
    });
    req.on('timeout', () => {
      req.destroy();
      finish({ ok: false, detail: `no answer within ${secs(timeoutMs)}` });
    });
    req.on('error', (err) => finish({ ok: false, detail: `could not connect (${err.code || err.message})` }));
    req.end();
  });
}

/**
 * Run every probe at once; a failing probe gets one more try `retryDelayMs` later, so a single dropped packet
 * doesn't count. Returns [{ check, ok, detail }].
 */
export async function runHealthChecks({ siteUrl, apiUrl, wsUrl }, { timeoutMs = 8000, retryDelayMs = 2000, probes } = {}) {
  const p = probes ?? { website: checkWebsite, api: checkApi, websocket: checkWebSocket };
  const checks = [
    ['Website', () => p.website(siteUrl, timeoutMs)],
    ['HTTP API + database', () => p.api(`${apiUrl.replace(/\/+$/, '')}/api/health`, timeoutMs)],
    ['WebSocket API', () => p.websocket(wsUrl, timeoutMs)],
  ];
  return Promise.all(checks.map(async ([check, probe]) => {
    let result = await probe();
    if (!result.ok) {
      await new Promise((r) => setTimeout(r, retryDelayMs));
      result = await probe();
    }
    return { check, ...result };
  }));
}

// ---------- log lines ----------
/**
 * One CloudWatch log line in a few words. Lambda's text format is "<time>\t<request id>\t<LEVEL>\t<message>" and our
 * messages are JSON (lib/log.js): show msg + the error message. Runtime failures ({errorType, errorMessage}), API
 * Gateway access-log lines and anything else are handled too.
 */
export function describeLogLine(message) {
  const text = String(message ?? '').trim();
  const brace = text.indexOf('{');
  if (brace >= 0) {
    try {
      const j = JSON.parse(text.slice(brace));
      if (Array.isArray(j.failures)) return j.failures.map((f) => `${f.check}: ${f.detail}`).join('; ');
      if (j.msg) {
        const where = j.path ? ` (${[j.method, j.path].filter(Boolean).join(' ')})` : '';
        const why = typeof j.error === 'string' ? j.error : j.error?.message;
        return cut(`${j.msg}${where}${why ? `: ${why}` : ''}`);
      }
      if (j.errorType || j.errorMessage) return cut(`${j.errorType ?? 'Error'}: ${j.errorMessage ?? ''}`);
      if (j.status && j.path) {
        const why = [j.integrationError, j.error].find((v) => v && v !== '-');
        return cut(`${j.method ?? ''} ${j.path} answered ${j.status}${why ? ` (${why})` : ''}`.trim());
      }
    } catch { /* not JSON after all */ }
  }
  // Strip Lambda's "<time>\t<request id>\t<LEVEL>\t" (or "<time> <request id> ") prefix.
  return cut(text.replace(/^\d{4}-\d\d-\d\dT\S+\s+[0-9a-f-]{36}\s+(?:[A-Z]+\s+)?/, ''));
}

function cut(s, max = 300) {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 3)}...` : one;
}

/** Log events ({timestamp, message}) as at most `max` lines, newest last; repeats are folded into "(x3)". */
export function evidenceLines(events, max = 8) {
  const byText = new Map();
  for (const e of [...events].sort((a, b) => a.timestamp - b.timestamp)) {
    const text = describeLogLine(e.message);
    if (!text) continue;
    const seen = byText.get(text);
    if (seen) {
      seen.count += 1;
      seen.last = e.timestamp;
    } else byText.set(text, { text, count: 1, last: e.timestamp });
  }
  const lines = [...byText.values()].sort((a, b) => a.last - b.last).slice(-max);
  return lines.map((l) => `${clock(l.last)}  ${l.text}${l.count > 1 ? `  (x${l.count})` : ''}`);
}

function clock(ms, timeZone = process.env.ALERT_TIME_ZONE || 'UTC') {
  try {
    return new Date(ms).toLocaleTimeString('en-GB', { timeZone, hour12: false });
  } catch {
    return new Date(ms).toISOString().slice(11, 19);
  }
}

// ---------- alarms ----------
// Where to look for the cause: [log group key, CloudWatch Logs filter pattern]. The keys map to the LOG_GROUP_*
// environment variables. CRASH matches our log('error') lines (console.error, so "ERROR" in Lambda's text format) and
// Lambda's own failures (uncaught exceptions, timeouts, init errors).
const CRASH = '?ERROR ?"Task timed out"';
const ALL_FUNCTIONS = [['api', CRASH], ['websocket', CRASH], ['timer', CRASH]];

const ALARM_KINDS = [
  {
    suffix: 'health-check',
    title: 'Quibble is down: the health checks are failing',
    resolved: 'Quibble is back up: the health checks pass again',
    sources: [['monitor', '{ $.msg = "health check failed" }']],
    advice: 'Every minute the monitor loads the website, calls /api/health (API Lambda + database) and opens a '
      + 'WebSocket. Checks failed two minutes running, so players probably cannot reach or play the game right now. '
      + 'The lines below say which part failed.',
  },
  {
    suffix: 'error-logs',
    title: 'Quibble logged errors',
    sources: ALL_FUNCTIONS,
    advice: 'The backend hit an unexpected error and logged it: the request failed for that player, but the function '
      + 'kept running. A one-off can be an AWS hiccup; the same error again and again is a bug.',
  },
  {
    suffix: 'api-lambda-errors',
    title: 'The REST API function crashed',
    sources: [['api', CRASH]],
    advice: 'The API Lambda failed outright (an uncaught exception, a timeout or a broken deploy). Sign-up, login, '
      + 'leaderboards and the admin console may not work.',
  },
  {
    suffix: 'websocket-lambda-errors',
    title: 'A WebSocket function crashed',
    sources: [['websocket', CRASH]],
    advice: 'The connect, disconnect or game-message Lambda failed outright. Players may not be able to join or play.',
  },
  {
    suffix: 'game-timer-errors',
    title: 'The game timer failed to advance a game',
    sources: [['timer', CRASH]],
    advice: 'Lambda retries timer steps by itself and a player reconnecting un-sticks a game, but a game may have paused.',
  },
  {
    suffix: 'http-api-5xx',
    title: 'The HTTP API is answering with server errors',
    sources: [['api', CRASH], ['access', '{ $.status = "5*" }']],
    advice: 'Five or more requests failed with a 5xx status within 5 minutes.',
  },
  {
    suffix: 'lambda-throttles',
    title: 'Lambda is throttling requests',
    advice: "The account hit its Lambda concurrency limit, so some requests waited or failed. Check the quota with "
      + '"npm run quota:lambda" and the concurrency graph on the dashboard.',
  },
  {
    suffix: 'game-timer-events-dropped',
    title: 'Game timer events were dropped',
    sources: [['timer', CRASH]],
    advice: 'Lambda gave up on some timer steps (too old or out of retries). Those games stall until a player reconnects.',
  },
  {
    suffix: 'game-timer-late',
    title: 'Game phases are running late',
    advice: "Timer events waited 5 s or more in Lambda's queue (throttling or retries), so questions and results "
      + 'reached players late.',
  },
  ...[['gameplay', 'GamePlay'], ['games', 'Games']].flatMap(([key, label]) => ['read', 'write'].map((op) => ({
    suffix: `${key}-table-${op}-throttles`,
    title: `DynamoDB is throttling ${op}s on the ${label} table`,
    advice: 'Too many requests hit one partition key at once (a hot key); some game actions were retried or failed.',
  }))),
];

/** What an alarm means, from its name (`<stack>-<suffix>`). Unknown alarms fall back to their description. */
export function alarmKind(alarmName, description) {
  // Longest suffix first: "games-table-read-throttles" must not be taken for a shorter suffix.
  const kind = [...ALARM_KINDS].sort((a, b) => b.suffix.length - a.suffix.length)
    .find((k) => String(alarmName).endsWith(`-${k.suffix}`));
  return kind ?? { suffix: null, title: description || `CloudWatch alarm ${alarmName}`, advice: description || '', sources: [] };
}

const consoleBase = (region) => `https://${region}.console.aws.amazon.com`;

/**
 * The email for a CloudWatch alarm's Lambda action (event = the payload CloudWatch sends). Null for an OK that isn't
 * a recovery: a new alarm goes INSUFFICIENT_DATA -> OK when it first gets data, and that's not news.
 */
export function alarmEmail(event, { evidence = [], stackName = 'quibble' } = {}) {
  const a = event.alarmData ?? {};
  const name = a.alarmName ?? 'unknown alarm';
  const state = a.state?.value ?? 'ALARM';
  if (state === 'OK' && a.previousState?.value !== 'ALARM') return null;
  const region = event.region || process.env.AWS_REGION || 'us-east-1';
  const kind = alarmKind(name, a.configuration?.description);
  const at = a.state?.timestamp ?? event.time;
  const links = table([
    ['Alarm', `${consoleBase(region)}/cloudwatch/home?region=${region}#alarmsV2:alarm/${encodeURIComponent(name)}`],
    ['Dashboard', `${consoleBase(region)}/cloudwatch/home?region=${region}#dashboards:name=${encodeURIComponent(stackName)}`],
    ['Admin', siteLink('admin.html#/system')],
  ]);

  if (state === 'OK') {
    const since = a.previousState?.timestamp;
    const title = kind.resolved ?? `Resolved: ${kind.title}`;
    return {
      subject: `[Quibble] ${title}`,
      body: [
        `${title}.`,
        '',
        table([
          ['Since', formatTime(at)],
          ['Was failing', since ? `from ${formatTime(since)} (${span(since, at)})` : null],
          ['Alarm', name],
        ]),
        '',
        links,
      ].join('\n'),
    };
  }

  const body = [
    `${kind.title}.`,
    '',
    table([
      ['Status', `${state}${a.previousState?.value ? ` (was ${a.previousState.value})` : ''}`],
      ['When', formatTime(at)],
      ['Alarm', name],
      ['Why', a.state?.reason],
    ]),
  ];
  if (kind.advice) body.push('', 'What it means', kind.advice);
  if (evidence.length) body.push('', 'Recent log lines (newest last)', ...evidence.map((l) => `  ${l}`));
  else if (kind.sources?.length) body.push('', 'No matching log lines in the last 15 minutes. Check the dashboard.');
  body.push('', links);
  return { subject: `[Quibble] ${state === 'ALARM' ? '' : `${state}: `}${kind.title}`, body: body.join('\n') };
}

// ---------- deploys ----------
const DEPLOY_STATES = {
  UPDATE_ROLLBACK_COMPLETE: {
    title: 'Deploy failed and was rolled back',
    meaning: 'CloudFormation undid the update, so the backend runs the version from before this deploy. The deploy '
      + 'script stops before uploading the frontend, so the pages are unchanged too: players are not affected.',
    next: 'Fix the cause below, then run "npm run deploy" again.',
  },
  UPDATE_ROLLBACK_FAILED: {
    title: 'Deploy failed and the rollback failed too',
    meaning: 'The stack is stuck between the old and the new version, and no deploy can run until it is fixed. Parts '
      + 'of the game may not work.',
    next: 'In the CloudFormation console open the stack, choose Stack actions > Continue update rollback (skip the '
      + 'resources it cannot roll back if asked), then deploy again.',
  },
  UPDATE_FAILED: {
    title: 'Deploy failed (rollback was turned off)',
    meaning: 'The stack is left half-updated.',
    next: 'Fix the cause and deploy again, or roll back from the CloudFormation console.',
  },
  ROLLBACK_COMPLETE: {
    title: 'Creating the stack failed',
    meaning: 'Nothing was deployed. A stack in this state cannot be updated.',
    next: 'Delete it ("sam delete --stack-name <stack>"), fix the cause, then deploy again.',
  },
  ROLLBACK_FAILED: {
    title: 'Creating the stack failed and the cleanup failed too',
    meaning: 'Some resources from the failed create may be left over.',
    next: 'Delete the stack from the CloudFormation console, then deploy again.',
  },
  DELETE_FAILED: {
    title: 'Deleting the stack failed',
    meaning: 'Usually the website bucket still has files in it.',
    next: 'Empty the bucket, then delete the stack again.',
  },
};
export const DEPLOY_FAILURE_STATES = Object.keys(DEPLOY_STATES);

const isStackItself = (e) => e.ResourceType === 'AWS::CloudFormation::Stack' && e.PhysicalResourceId === e.StackId;

/**
 * Why the latest stack operation failed, from DescribeStackEvents output (newest first): the resources that failed,
 * oldest first, without the "Resource update cancelled" knock-on failures. At most `max`.
 */
export function rootCauses(events, max = 5) {
  const operation = [];
  for (const e of events) {
    if (isStackItself(e) && /_IN_PROGRESS$/.test(e.ResourceStatus ?? '') && e.ResourceStatusReason === 'User Initiated') break;
    operation.push(e);
  }
  return operation
    .filter((e) => /FAILED$/.test(e.ResourceStatus ?? '') && !isStackItself(e) && !/cancel/i.test(e.ResourceStatusReason ?? ''))
    .reverse()
    .slice(0, max)
    .map((e) => ({
      resource: e.LogicalResourceId,
      type: e.ResourceType,
      status: e.ResourceStatus,
      reason: e.ResourceStatusReason ?? '',
      at: e.Timestamp instanceof Date ? e.Timestamp.toISOString() : e.Timestamp,
    }));
}

/** The email for a CloudFormation "Stack Status Change" event that ended in failure. Null for any other status. */
export function deployEmail(event, { causes = [] } = {}) {
  const d = event.detail ?? {};
  const status = d['status-details']?.status ?? d.status;
  const info = DEPLOY_STATES[status];
  if (!info) return null;
  const stackId = d['stack-id'] ?? event.resources?.[0] ?? '';
  const stackName = stackId.split('/')[1] || 'quibble';
  const region = event.region || process.env.AWS_REGION || 'us-east-1';
  const reason = d['status-details']?.['status-reason'];
  const body = [
    `${info.title}.`,
    '',
    table([
      ['Stack', `${stackName} (${region})`],
      ['Status', status],
      ['When', formatTime(event.time)],
    ]),
    '',
    'What it means',
    info.meaning,
    '',
    'Cause',
    ...(causes.length
      ? causes.map((c) => `  - ${c.resource} (${c.type}) ${c.status}: ${c.reason}`)
      : [`  ${reason || 'CloudFormation gave no reason. Check the stack events.'}`]),
    '',
    'What to do',
    info.next.replace('<stack>', stackName),
    '',
    table([['Stack events', `${consoleBase(region)}/cloudformation/home?region=${region}#/stacks/events?stackId=${encodeURIComponent(stackId)}`]]),
  ];
  return { subject: `[Quibble] ${info.title} (${stackName})`, body: body.join('\n') };
}
