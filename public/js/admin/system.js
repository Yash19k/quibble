// System health: is the backend answering, how fast is the database, what is it running on, the game settings in
// force, and how big every table is.
import { api, el } from '../common.js';
import { aicon } from './icons.js';
import { pageHead, kpi, dataTable, button, act, loading, failed, num, bytes, dateTime, when, pill, fill,
} from './ui.js';

const SETTINGS = [
  ['maxPlayers', 'Players per game', (v) => num(v), 'Most players one game accepts.'],
  ['lateGraceMs', 'Late answers accepted', (v) => `${num(v)} ms`, 'Answers that reached AWS this long after the buzzer still count.'],
  ['revealMs', 'Results pause', (v) => `${num(v)} ms`, "How long each question's results stay up."],
  ['broadcastWindowMs', 'Lobby update window', (v) => `${num(v)} ms`, 'Lobby lists are pushed at most once per window.'],
  ['registerMaxPerIp', 'Sign-ups per network', (v) => `${num(v)} / hour`, 'Sized for a classroom on one Wi-Fi.'],
  ['loginFailMaxPerIp', 'Failed logins per network', (v) => `${num(v)} / 15 min`, null],
  ['loginFailMaxPerEmail', 'Failed logins per account', (v) => `${num(v)} / 15 min`, null],
];

export async function render(body, args, ctx) {
  let s;
  const started = performance.now();
  loading(body);
  try {
    s = await api('/api/admin/system');
  } catch (err) {
    return failed(body, err, () => render(body, args, ctx));
  }
  if (!ctx.isCurrent()) return undefined;
  const roundTrip = Math.round(performance.now() - started);
  ctx.setCount('live', s.live.liveGames);
  const r = s.runtime;
  const kv = (rows) => el('dl', { class: 'kv' }, rows.filter(Boolean).flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)]));
  const totalItems = s.tables.reduce((n, t) => n + (t.items || 0), 0);
  const totalBytes = s.tables.reduce((n, t) => n + (t.bytes || 0), 0);

  fill(body,
    pageHead('System health', `Checked ${new Date(s.checkedAt).toLocaleTimeString()}.`, button('Check again', 'refresh', act('Checking…', () => render(body, args, ctx)), 'ghost')),
    el('div', { class: 'kpis' },
      kpi({ label: 'API', icon: 'checkCircle', value: 'Up', sub: `answered in ${num(roundTrip)} ms` }),
      kpi({ label: 'Database', icon: 'database', value: `${num(s.health.dbLatencyMs)} ms`, sub: 'one read, from the API' }),
      kpi({ label: 'Open sockets', icon: 'radio', value: s.live.sockets, sub: `${num(s.live.onlineUsers)} players online` }),
      kpi({ label: 'Live games', icon: 'gamepad', value: s.live.liveGames, sub: 'lobbies and games in progress' })),
    el('div', { class: 'grid2' },
      el('div', { class: 'card' },
        el('h3', { class: 'with-icon', style: 'margin-bottom:14px' }, aicon('server', { size: 20 }), 'Runtime'),
        kv([
          ['Running on', r.local ? 'Local dev server (DynamoDB Local)' : 'AWS Lambda'],
          ['Region', r.region ?? '–'],
          ['Function', el('span', { class: 'mono' }, r.functionName)],
          r.memoryMb ? ['Memory', `${num(r.memoryMb)} MB`] : null,
          ['Node.js', r.node],
          ['Game protocol', `v${r.protocol}`],
          ['Container started', el('span', { title: dateTime(r.containerStartedAt) }, when(r.containerStartedAt))],
        ]),
        el('p', { class: 'hint' }, 'Logs, alarms and request metrics are on the CloudWatch dashboard the deploy created (stack output DashboardUrl).')),
      el('div', { class: 'card' },
        el('h3', { class: 'with-icon', style: 'margin-bottom:14px' }, aicon('zap', { size: 20 }), 'Game settings'),
        kv(SETTINGS.map(([key, label, fmt, help]) => [label, el('span', {}, el('b', {}, fmt(s.config[key])), help ? el('span', { class: 'cell-sub' }, help) : null)])),
        el('p', { class: 'hint' }, 'Change them with template parameters on the next deploy, e.g. npm run deploy -- MaxPlayers=250.'))),
    el('div', { class: 'card flush' },
      el('div', { class: 'card-head' }, el('h3', {}, 'DynamoDB tables'),
        el('span', { class: 'muted' }, `${num(totalItems)} items · ${bytes(totalBytes)}${r.local ? '' : ' · AWS updates these counts about every 6 hours'}`)),
      dataTable([
        { label: 'Table', cell: (t) => el('span', {}, el('span', { class: 'cell-main' }, t.label), el('span', { class: 'cell-sub' }, t.name)) },
        { label: 'Items', num: true, cell: (t) => num(t.items) },
        { label: 'Size', num: true, cell: (t) => bytes(t.bytes) },
        { label: 'Indexes', cell: (t) => (t.indexes.length ? el('span', { class: 'mono' }, t.indexes.join(', ')) : el('span', { class: 'muted' }, 'none')) },
        { label: 'Billing', cell: (t) => (t.billing === 'PAY_PER_REQUEST' ? 'on demand' : t.billing ? t.billing.toLowerCase() : '–') },
        { label: 'Status', cell: (t) => pill(t.status.toLowerCase(), t.status === 'ACTIVE' ? 'shared' : 'bad') },
      ], s.tables)));
  return undefined;
}
