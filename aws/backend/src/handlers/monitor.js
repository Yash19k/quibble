// Monitor: watches production and emails the alerts topic (lib/alerts.js). Invoked by
//   - an EventBridge schedule every minute     -> uptime probes (website, /api/health, WebSocket); the result is the
//                                                 HealthCheckFailed metric, which the <stack>-health-check alarm watches
//   - CloudWatch alarm actions                 -> an email saying what broke, with the matching error log lines
//   - CloudFormation stack status events       -> an email when a deploy fails or rolls back, with the failed resources
//   - { "action": "test" } (npm run alerts:test) -> a test email, and whether the address has confirmed
// If sending fails the invocation throws, so Lambda retries it; the <stack>-monitor-errors alarm (which emails through
// SNS directly, not through this function) catches a monitor that keeps failing.
import { CloudWatchLogsClient, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { CloudFormationClient, DescribeStackEventsCommand } from '@aws-sdk/client-cloudformation';
import { SNSClient, ListSubscriptionsByTopicCommand } from '@aws-sdk/client-sns';
import { log, metric } from '../lib/log.js';
import { formatTime, sendAlert, table } from '../lib/alerts.js';
import { alarmEmail, alarmKind, deployEmail, evidenceLines, rootCauses, runHealthChecks } from '../lib/monitor.js';

const logs = new CloudWatchLogsClient({});
const cfn = new CloudFormationClient({});
const sns = new SNSClient({});

const LOG_GROUPS = {
  api: process.env.LOG_GROUP_API,
  websocket: process.env.LOG_GROUP_WEBSOCKET,
  timer: process.env.LOG_GROUP_TIMER,
  access: process.env.LOG_GROUP_ACCESS,
  monitor: process.env.LOG_GROUP_MONITOR,
};
const EVIDENCE_WINDOW_MS = 15 * 60_000;

export const handler = async (event = {}) => {
  if (event['detail-type'] === 'Scheduled Event') return healthCheck();
  if (event.alarmData) return onAlarm(event);
  if (event.source === 'aws.cloudformation') return onStackEvent(event);
  if (event.action === 'test') return testEmail();
  log('warn', 'monitor: unexpected event', { keys: Object.keys(event) });
  return { ignored: true };
};

async function healthCheck() {
  const results = await runHealthChecks({
    siteUrl: process.env.SITE_URL ? `${process.env.SITE_URL}/index.html` : '',
    apiUrl: process.env.HTTP_API_URL ?? '',
    wsUrl: process.env.WS_URL ?? '',
  });
  const failures = results.filter((r) => !r.ok);
  metric('HealthCheckFailed', failures.length ? 1 : 0);
  if (failures.length) log('warn', 'health check failed', { failures: failures.map(({ check, detail }) => ({ check, detail })) });
  return { ok: !failures.length, results };
}

/** The log lines behind an alarm: each [group, pattern] source over the last 15 minutes. */
async function evidenceFor(kind, endMs) {
  const events = [];
  await Promise.all((kind.sources ?? []).map(async ([key, pattern]) => {
    const logGroupName = LOG_GROUPS[key];
    if (!logGroupName) return;
    try {
      const res = await logs.send(new FilterLogEventsCommand({
        logGroupName, filterPattern: pattern, startTime: endMs - EVIDENCE_WINDOW_MS, endTime: endMs, limit: 50,
      }));
      events.push(...(res.events ?? []));
    } catch (error) {
      log('warn', 'monitor: could not read logs', { logGroupName, error });
    }
  }));
  return evidenceLines(events);
}

async function onAlarm(event) {
  const a = event.alarmData;
  const state = a.state?.value;
  const kind = alarmKind(a.alarmName, a.configuration?.description);
  const evidence = state === 'ALARM' ? await evidenceFor(kind, Date.now()) : [];
  const mail = alarmEmail(event, { evidence, stackName: process.env.STACK_NAME });
  if (!mail) return { ignored: `${a.alarmName}: ${a.previousState?.value} -> ${state}` };
  await sendAlert(mail.subject, mail.body);
  return { sent: mail.subject };
}

/** DescribeStackEvents, newest first, until the start of the latest operation (at most 5 pages of 100). */
async function latestStackEvents(stackId) {
  const events = [];
  let NextToken;
  for (let page = 0; page < 5; page++) {
    const res = await cfn.send(new DescribeStackEventsCommand({ StackName: stackId, NextToken }));
    events.push(...(res.StackEvents ?? []));
    NextToken = res.NextToken;
    const started = events.some((e) => e.ResourceType === 'AWS::CloudFormation::Stack' && e.ResourceStatusReason === 'User Initiated');
    if (!NextToken || started) break;
  }
  return events;
}

async function onStackEvent(event) {
  const d = event.detail ?? {};
  let causes = [];
  try {
    causes = rootCauses(await latestStackEvents(d['stack-id'] ?? event.resources?.[0]));
  } catch (error) {
    log('warn', 'monitor: could not read the stack events', { error });
  }
  const mail = deployEmail(event, { causes });
  if (!mail) return { ignored: d['status-details']?.status ?? null };
  await sendAlert(mail.subject, mail.body);
  return { sent: mail.subject };
}

/** Send a test email and report the subscriptions (a new address stays "pending" until its owner confirms). */
async function testEmail() {
  const now = new Date().toISOString();
  await sendAlert('[Quibble] Test alert: email alerts are working', [
    'This is a test from the Quibble monitor. If you can read it, alert emails reach you.',
    '',
    table([['Sent', formatTime(now)], ['Stack', process.env.STACK_NAME]]),
    '',
    'You will get an email when:',
    '  - the site, the API, the database or the WebSockets stop answering (and another when they are back)',
    '  - a function crashes or logs an error, the API answers 5xx, or Lambda / DynamoDB throttle',
    '  - a deploy fails or rolls back',
    '  - an admin grants or removes admin rights, bans or deletes a player, resets a password or bulk-deletes questions',
  ].join('\n'));
  const res = await sns.send(new ListSubscriptionsByTopicCommand({ TopicArn: process.env.ALERTS_TOPIC }));
  const subscriptions = (res.Subscriptions ?? []).map((s) => ({
    protocol: s.Protocol,
    endpoint: s.Endpoint,
    confirmed: !!s.SubscriptionArn && s.SubscriptionArn.startsWith('arn:'),
  }));
  return { sent: true, subscriptions };
}
