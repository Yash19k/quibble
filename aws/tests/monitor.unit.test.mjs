// Unit tests for the email alerts: the uptime probes (against a local server), how log lines, alarms and failed deploys
// read in an email, and the admin-activity tripwire. No AWS needed:
//   node --test aws/tests/monitor.unit.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { subjectLine, formatTime, span, auditAlert, isSensitive, sendAlert } from '../backend/src/lib/alerts.js';
import {
  checkApi, checkWebsite, checkWebSocket, runHealthChecks, describeLogLine, evidenceLines, alarmKind, alarmEmail,
  rootCauses, deployEmail, DEPLOY_FAILURE_STATES,
} from '../backend/src/lib/monitor.js';

delete process.env.ALERTS_TOPIC;
process.env.ALERT_TIME_ZONE = 'Asia/Kolkata';
process.env.SITE_URL = 'https://site.example';

/** A local server whose answer the test sets per path. */
async function server(routes) {
  const srv = http.createServer((req, res) => {
    const route = routes[req.url.split('?')[0]] ?? { status: 404, body: 'not found' };
    if (route.hang) return; // never answers
    res.writeHead(route.status, { 'content-type': route.type ?? 'text/plain' });
    res.end(route.body ?? '');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => srv.close(r)) };
}

test('email subjects are one line of ASCII, at most 100 characters', () => {
  assert.equal(subjectLine('[Quibble] Café → down\nnow'), '[Quibble] Cafe down now');
  assert.equal(subjectLine('x'.repeat(150)).length, 100);
  assert.ok(subjectLine('x'.repeat(150)).endsWith('...'));
  assert.equal(subjectLine('  '), 'Quibble alert');
});

test('times are shown in the alert time zone', () => {
  assert.equal(formatTime('2026-11-21T13:09:05Z', 'Asia/Kolkata'), '21 Nov 2026, 18:39:05 (Asia/Kolkata)');
  assert.equal(formatTime('2026-11-21T13:09:05Z', 'Not/AZone'), '2026-11-21T13:09:05.000Z');
  assert.equal(span('2026-11-21T10:00:00Z', '2026-11-21T10:00:40Z'), '40 s');
  assert.equal(span('2026-11-21T10:00:00Z', '2026-11-21T10:12:00Z'), '12 min');
  assert.equal(span('2026-11-21T10:00:00Z', '2026-11-21T13:05:00Z'), '3 h 5 min');
});

test('sensitive admin actions are emailed, routine ones are not', async () => {
  const entry = {
    at: '2026-11-21T13:09:05Z', adminId: 'a1', adminName: 'yash', action: 'user.role',
    targetType: 'user', targetId: 'u2', targetLabel: 'mallory', details: { role: 'admin' },
  };
  const mail = auditAlert(entry);
  assert.equal(mail.subject, '[Quibble] Admin activity: yash made mallory an admin');
  assert.match(mail.body, /^yash made mallory an admin\./);
  assert.match(mail.body, /When: +21 Nov 2026, 18:39:05 \(Asia\/Kolkata\)/);
  assert.match(mail.body, /https:\/\/site\.example\/admin\.html#\/activity/);
  assert.match(auditAlert({ ...entry, details: { role: 'player' } }).subject, /yash removed mallory as an admin/);
  assert.match(auditAlert({ ...entry, action: 'question.bulkDelete', details: { count: 40 } }).subject, /deleted 40 questions at once/);
  for (const action of ['user.ban', 'user.delete', 'user.resetPassword']) assert.ok(isSensitive(action), action);
  for (const action of ['question.update', 'announcement.set', 'game.end', 'user.unban']) {
    assert.equal(auditAlert({ ...entry, action }), null, action);
  }
  assert.equal(await sendAlert('x', 'y'), false, 'no topic configured (local dev): nothing is sent');
});

test('log lines read as a few words', () => {
  const lambda = (level, obj) => `2026-11-21T13:09:05.123Z\t38067189-85a5-4876-84de-9a0d2abc7756\t${level}\t${JSON.stringify(obj)}\n`;
  assert.equal(describeLogLine(lambda('ERROR', { level: 'error', msg: 'ws answer failed', error: { message: 'boom' } })), 'ws answer failed: boom');
  assert.equal(
    describeLogLine(lambda('ERROR', { level: 'error', msg: 'Unhandled API error', method: 'POST', path: '/api/quizzes', error: { message: 'x is undefined' } })),
    'Unhandled API error (POST /api/quizzes): x is undefined',
  );
  assert.equal(
    describeLogLine('2026-11-21T13:09:05.123Z\t38067189-85a5-4876-84de-9a0d2abc7756\tERROR\tInvoke Error \t{"errorType":"TypeError","errorMessage":"bad","stack":[]}'),
    'TypeError: bad',
  );
  assert.equal(
    describeLogLine('2026-11-21T13:09:05.123Z 38067189-85a5-4876-84de-9a0d2abc7756 Task timed out after 15.02 seconds'),
    'Task timed out after 15.02 seconds',
  );
  assert.equal(
    describeLogLine('{"requestId":"r","method":"GET","path":"/api/leaderboard","status":"502","error":"-","integrationError":"timeout"}'),
    'GET /api/leaderboard answered 502 (timeout)',
  );
  assert.equal(
    describeLogLine(lambda('INFO', { level: 'warn', msg: 'health check failed', failures: [{ check: 'Website', detail: 'HTTP 503' }, { check: 'WebSocket API', detail: 'no answer within 8 s' }] })),
    'Website: HTTP 503; WebSocket API: no answer within 8 s',
  );
});

test('evidence folds repeats and keeps the newest lines', () => {
  const t = Date.parse('2026-11-21T13:00:00Z');
  const ev = (s, msg) => ({ timestamp: t + s * 1000, message: JSON.stringify({ level: 'error', msg }) });
  const lines = evidenceLines([ev(30, 'b failed'), ev(0, 'a failed'), ev(10, 'a failed'), ev(20, 'a failed')]);
  assert.deepEqual(lines, ['18:30:20  a failed  (x3)', '18:30:30  b failed']);
  const many = evidenceLines(Array.from({ length: 20 }, (_, i) => ev(i, `error ${i}`)), 5);
  assert.equal(many.length, 5);
  assert.match(many.at(-1), /error 19$/);
});

test('alarms are matched by name, the longest suffix first', () => {
  assert.equal(alarmKind('quibble-games-table-read-throttles').title, 'DynamoDB is throttling reads on the Games table');
  assert.equal(alarmKind('quibble-gameplay-table-write-throttles').title, 'DynamoDB is throttling writes on the GamePlay table');
  assert.equal(alarmKind('quibble-health-check').suffix, 'health-check');
  assert.equal(alarmKind('quibble-something-new', 'A new alarm').title, 'A new alarm');
});

const alarmEvent = (state, previous = 'OK') => ({
  source: 'aws.cloudwatch',
  region: 'ap-south-1',
  time: '2026-11-21T13:09:05.000+0000',
  alarmData: {
    alarmName: 'quibble-health-check',
    state: { value: state, reason: 'Threshold Crossed: 2 out of the last 3 datapoints were >= 1.0', timestamp: '2026-11-21T13:09:05.000+0000' },
    previousState: { value: previous, timestamp: '2026-11-21T12:51:05.000+0000' },
    configuration: { description: 'The website, the HTTP API + database or the WebSocket API stopped answering' },
  },
});

test('an alarm email says what broke, shows the log lines and links to the alarm', () => {
  const { subject, body } = alarmEmail(alarmEvent('ALARM'), { evidence: ['18:38:01  Website: HTTP 503'] });
  assert.equal(subject, '[Quibble] Quibble is down: the health checks are failing');
  assert.match(body, /Status: +ALARM \(was OK\)/);
  assert.match(body, /Recent log lines \(newest last\)\n {2}18:38:01 {2}Website: HTTP 503/);
  assert.match(body, /#alarmsV2:alarm\/quibble-health-check/);
  assert.match(body, /admin\.html#\/system/);
  assert.match(alarmEmail(alarmEvent('ALARM')).body, /No matching log lines/);
});

test('a recovered health check says how long it was down', () => {
  const { subject, body } = alarmEmail(alarmEvent('OK', 'ALARM'));
  assert.equal(subject, '[Quibble] Quibble is back up: the health checks pass again');
  assert.match(body, /Was failing: +from 21 Nov 2026, 18:21:05 \(Asia\/Kolkata\) \(18 min\)/);
  assert.equal(alarmEmail(alarmEvent('OK', 'INSUFFICIENT_DATA')), null, 'a brand-new alarm turning OK is not a recovery');
});

// DescribeStackEvents output, newest first.
const STACK_ID = 'arn:aws:cloudformation:ap-south-1:123456789012:stack/quibble/abc';
const stackEvent = (LogicalResourceId, ResourceStatus, ResourceStatusReason, ResourceType = 'AWS::Lambda::Function') => ({
  StackId: STACK_ID, LogicalResourceId, ResourceType, ResourceStatus, ResourceStatusReason,
  PhysicalResourceId: ResourceType === 'AWS::CloudFormation::Stack' ? STACK_ID : `${LogicalResourceId}-id`,
  Timestamp: new Date('2026-11-21T13:00:00Z'),
});
const STACK_EVENTS = [
  stackEvent('quibble', 'UPDATE_ROLLBACK_COMPLETE', '', 'AWS::CloudFormation::Stack'),
  stackEvent('quibble', 'UPDATE_ROLLBACK_IN_PROGRESS', 'The following resource(s) failed to update: [ApiFunction].', 'AWS::CloudFormation::Stack'),
  stackEvent('MonitorFunction', 'UPDATE_FAILED', 'Resource update cancelled'),
  stackEvent('ApiFunction', 'UPDATE_FAILED', 'Resource handler returned message: "Unzipped size must be smaller than 262144000 bytes"'),
  stackEvent('ApiFunction', 'UPDATE_IN_PROGRESS', ''),
  stackEvent('quibble', 'UPDATE_IN_PROGRESS', 'User Initiated', 'AWS::CloudFormation::Stack'),
  stackEvent('OldFunction', 'UPDATE_FAILED', 'an older deploy: not this one'),
];

test('the cause of a failed deploy is the first resource that failed, without the cancelled ones', () => {
  const causes = rootCauses(STACK_EVENTS);
  assert.equal(causes.length, 1);
  assert.equal(causes[0].resource, 'ApiFunction');
  assert.match(causes[0].reason, /Unzipped size/);
});

test('a failed deploy email explains the rollback and the cause', () => {
  const event = {
    source: 'aws.cloudformation', 'detail-type': 'CloudFormation Stack Status Change', region: 'ap-south-1',
    time: '2026-11-21T13:09:05Z', resources: [STACK_ID],
    detail: { 'stack-id': STACK_ID, 'status-details': { status: 'UPDATE_ROLLBACK_COMPLETE', 'status-reason': '' } },
  };
  const { subject, body } = deployEmail(event, { causes: rootCauses(STACK_EVENTS) });
  assert.equal(subject, '[Quibble] Deploy failed and was rolled back (quibble)');
  assert.match(body, /players are not affected/);
  assert.match(body, /- ApiFunction \(AWS::Lambda::Function\) UPDATE_FAILED: Resource handler returned message/);
  assert.match(body, /cloudformation\/home\?region=ap-south-1#\/stacks\/events\?stackId=arn%3Aaws%3Acloudformation/);
  const stuck = deployEmail({ ...event, detail: { ...event.detail, 'status-details': { status: 'UPDATE_ROLLBACK_FAILED' } } });
  assert.match(stuck.body, /Continue update rollback/);
  assert.equal(deployEmail({ ...event, detail: { ...event.detail, 'status-details': { status: 'UPDATE_COMPLETE' } } }), null);
  assert.ok(DEPLOY_FAILURE_STATES.includes('UPDATE_ROLLBACK_COMPLETE'));
});

test('probes: website, API + database, WebSocket handshake', async (t) => {
  const s = await server({
    '/index.html': { status: 200, type: 'text/html', body: '<!doctype html><html><body>Quibble</body></html>' },
    '/blank.html': { status: 200, body: 'hello' },
    '/gone.html': { status: 503, body: 'Service Unavailable' },
    '/api/health': { status: 200, type: 'application/json', body: '{"ok":true,"db":"ok"}' },
    '/broken/api/health': { status: 500, type: 'application/json', body: '{"error":"Internal server error"}' },
    '/slow/api/health': { hang: true },
    '/prod': { status: 401, body: 'unauthorized' },
    '/nostage': { status: 403, body: 'Forbidden' },
    '/crashing': { status: 500, body: 'Internal server error' },
  });
  t.after(s.close);
  const ws = s.base.replace('http:', 'ws:');

  assert.equal((await checkWebsite(`${s.base}/index.html`)).ok, true);
  assert.deepEqual(await checkWebsite(`${s.base}/blank.html`), { ok: false, detail: 'HTTP 200 but the page is not HTML' });
  assert.match((await checkWebsite(`${s.base}/gone.html`)).detail, /^HTTP 503/);
  assert.match((await checkWebsite('http://127.0.0.1:1/index.html')).detail, /^could not connect/);

  assert.equal((await checkApi(`${s.base}/api/health`)).ok, true);
  assert.deepEqual(await checkApi(`${s.base}/broken/api/health`), { ok: false, detail: 'HTTP 500 (Internal server error)' });
  assert.deepEqual(await checkApi(`${s.base}/slow/api/health`, 300), { ok: false, detail: 'no answer within 0.3 s' });

  assert.equal((await checkWebSocket(`${ws}/prod`)).ok, true, 'a socket without a login is refused with 401: healthy');
  assert.match((await checkWebSocket(`${ws}/nostage`)).detail, /^HTTP 403/);
  assert.match((await checkWebSocket(`${ws}/crashing`)).detail, /^HTTP 500 .*expected 401/);
});

test('a failing probe is retried once before it counts', async () => {
  let calls = 0;
  const flaky = async () => (++calls === 1 ? { ok: false, detail: 'blip' } : { ok: true, detail: 'fine' });
  const down = async () => ({ ok: false, detail: 'HTTP 503' });
  const up = async () => ({ ok: true, detail: 'fine' });
  const results = await runHealthChecks(
    { siteUrl: 's', apiUrl: 'https://api.example/', wsUrl: 'w' },
    { retryDelayMs: 1, probes: { website: flaky, api: up, websocket: down } },
  );
  assert.deepEqual(results.map((r) => [r.check, r.ok]), [['Website', true], ['HTTP API + database', true], ['WebSocket API', false]]);
  assert.equal(calls, 2);
});
