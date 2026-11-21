// Email alerts. template.yaml creates one SNS topic (ALERTS_TOPIC) and subscribes the AlertEmail address to it; AWS
// asks that address to confirm once. Two things send to it:
//   - the monitor function (handlers/monitor.js): alarms, failed deploys and the health checks
//   - the admin audit log (lib/admin.js): sensitive admin actions, as a tripwire against a stolen admin account
// Without ALERTS_TOPIC (the local dev server, tests) an alert is only logged.
import { log } from './log.js';

const SUBJECT_MAX = 100; // SNS: at most 100 printable ASCII characters, no line breaks

/** An SNS-safe email subject: plain ASCII on one line, cut to 100 characters. */
export function subjectLine(text) {
  const clean = String(text ?? '')
    .normalize('NFKD')
    .replace(/\s+/g, ' ') // line breaks become spaces before anything non-ASCII is dropped
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/ {2,}/g, ' ')
    .trim();
  if (!clean) return 'Quibble alert';
  return clean.length > SUBJECT_MAX ? `${clean.slice(0, SUBJECT_MAX - 3)}...` : clean;
}

/** "21 Nov 2026, 18:39:05 (Asia/Kolkata)" in ALERT_TIME_ZONE (a template parameter, UTC by default). */
export function formatTime(when, timeZone = process.env.ALERT_TIME_ZONE || 'UTC') {
  const d = new Date(when);
  if (!Number.isFinite(d.getTime())) return String(when ?? '');
  try {
    const text = d.toLocaleString('en-GB', {
      timeZone, day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
    return `${text} (${timeZone})`;
  } catch {
    return d.toISOString(); // an unknown time zone name
  }
}

/** How long between two times, in words: "45 s", "12 min", "3 h 5 min". */
export function span(fromIso, toIso) {
  const s = Math.max(0, Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 1000));
  if (!Number.isFinite(s)) return null;
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** The site's HTTPS base address (SITE_URL), for links into the admin console. Null when unknown. */
export const siteLink = (page) => (process.env.SITE_URL ? `${process.env.SITE_URL.replace(/\/+$/, '')}/${page}` : null);

/** Aligned "Label:  value" lines; rows with an empty value are left out. */
export function table(rows) {
  const kept = rows.filter(([, v]) => v !== null && v !== undefined && v !== '');
  const width = Math.max(0, ...kept.map(([k]) => k.length)) + 2;
  return kept.map(([k, v]) => `${`${k}:`.padEnd(width)}${v}`).join('\n');
}

let sns;
/** Email `subject` / `body` to everyone subscribed to the alerts topic. Returns false when no topic is configured. */
export async function sendAlert(subject, body) {
  const topic = process.env.ALERTS_TOPIC;
  if (!topic) {
    log('info', 'alert not sent (no ALERTS_TOPIC)', { subject });
    return false;
  }
  // Loaded on first use: the API function only needs it for the rare sensitive admin action.
  const { SNSClient, PublishCommand } = await import('@aws-sdk/client-sns');
  sns ??= new SNSClient({});
  const footer = `\n\n--\nSent by the ${process.env.STACK_NAME || 'quibble'} stack's alerts topic. Change the address with: npm run deploy -- AlertEmail=you@example.com`;
  await sns.send(new PublishCommand({ TopicArn: topic, Subject: subjectLine(subject), Message: `${body}${footer}` }));
  log('info', 'alert sent', { subject: subjectLine(subject) });
  return true;
}

// ---------- the activity log tripwire ----------
// Admin actions worth an email: they hand out power, lock people out or destroy data. Routine moderation (editing a
// question, ending a game, the announcement) only goes to the Activity log page.
const SENSITIVE = {
  'user.role': (a, t, d) => (d.role === 'admin' ? `${a} made ${t} an admin` : `${a} removed ${t} as an admin`),
  'user.ban': (a, t) => `${a} banned ${t}`,
  'user.delete': (a, t) => `${a} deleted the account ${t}`,
  'user.resetPassword': (a, t) => `${a} reset the password of ${t}`,
  'question.bulkDelete': (a, _t, d) => `${a} deleted ${d.count ?? 'several'} questions at once`,
};

export const isSensitive = (action) => Object.hasOwn(SENSITIVE, action);

const detailText = (details = {}) => {
  const parts = Object.entries(details)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
  return parts.length ? parts.join(', ') : null;
};

/** The email for one audit-log entry (the item lib/admin.js writes), or null when the action isn't sensitive. */
export function auditAlert(entry) {
  const describe = SENSITIVE[entry.action];
  if (!describe) return null;
  const admin = entry.adminName || 'An admin';
  const target = entry.targetLabel || entry.targetId || 'an item';
  const what = describe(admin, target, entry.details ?? {});
  const body = [
    `${what}.`,
    '',
    table([
      ['When', formatTime(entry.at)],
      ['Admin', `${admin}${entry.adminId ? ` (id ${entry.adminId})` : ''}`],
      ['Action', entry.action],
      ['Target', entry.targetType ? `${target} (${entry.targetType}${entry.targetId ? ` ${entry.targetId}` : ''})` : target],
      ['Details', detailText(entry.details)],
    ]),
    '',
    'If you or an admin you trust did this, there is nothing to do.',
    'If not, someone may be using an admin account: open the admin console, check the Activity log, and on the',
    "Players page use Reset password and Sign out everywhere on that admin account (or remove its admin role).",
    '',
    table([['Activity log', siteLink('admin.html#/activity')]]),
  ].join('\n');
  return { subject: `[Quibble] Admin activity: ${what}`, body };
}
