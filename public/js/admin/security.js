// Security: the abuse limits in force and every counter of the current windows (sign-ups per IP, failed logins per IP
// and per account). A blocked IP or account can be let back in right away.
import { api, el, toast, confirmDialog } from '../common.js';
import { aicon } from './icons.js';
import { pageHead, kpi, dataTable, button, act, loading, failed, empty, when, num, hrefs, link, pill, fill,
} from './ui.js';

const KINDS = {
  'signup-ip': ['Sign-ups', 'from one network, per hour'],
  'login-ip': ['Failed logins', 'from one network, per 15 min'],
  'login-account': ['Failed logins', 'on one account, per 15 min'],
};

export async function render(body, args, ctx) {
  let data;
  loading(body);
  try {
    data = await api('/api/admin/ratelimits');
  } catch (err) {
    return failed(body, err, () => render(body, args, ctx));
  }
  if (!ctx.isCurrent()) return undefined;
  const reload = () => render(body, args, ctx);
  const blocked = data.counters.filter((c) => c.blocked);
  const L = data.limits;

  fill(body,
    pageHead('Security', 'Sign-up and login limits, and who is hitting them right now. Counters reset on their own when their window ends.',
      button('Refresh', 'refresh', act('…', reload), 'ghost')),
    el('div', { class: 'kpis' },
      kpi({ label: 'Blocked now', icon: 'ban', value: blocked.length, sub: blocked.length ? 'networks or accounts' : 'nobody is blocked' }),
      kpi({ label: 'Active counters', icon: 'pulse', value: data.counters.length, sub: 'in the current windows' }),
      kpi({ label: 'Sign-up limit', icon: 'userPlus', value: num(L.signupsPerIpPerHour), sub: 'per network, per hour' }),
      kpi({ label: 'Failed-login limit', icon: 'lock', value: num(L.failedLoginsPerAccount), sub: `per account (${num(L.failedLoginsPerIp)} per network), per 15 min` })),
    el('div', { class: 'card flush' },
      el('div', { class: 'card-head' }, el('h3', {}, 'Counters'), el('span', { class: 'muted' }, 'A whole classroom often shares one network address')),
      dataTable([
        { label: 'Limit', cell: (c) => el('span', {}, el('span', { class: 'cell-main' }, KINDS[c.kind][0]), el('span', { class: 'cell-sub' }, KINDS[c.kind][1])) },
        {
          label: 'Who', cell: (c) => (c.kind === 'login-account'
            ? (c.user ? el('span', {}, link(hrefs.user(c.user.id), c.user.username), el('span', { class: 'cell-sub' }, c.subject)) : el('span', { class: 'muted' }, 'an email with no account'))
            : el('span', { class: 'mono' }, c.subject)),
        },
        {
          label: 'Count', cls: 'nowrap', cell: (c) => el('span', { class: 'hit-rate' },
            el('span', { class: 'meter', 'aria-hidden': 'true' }, el('i', { style: `width:${Math.min(100, Math.round((c.hits / c.limit) * 100))}%;${c.blocked ? 'background:var(--bad)' : ''}` })),
            `${num(c.hits)} / ${num(c.limit)}`),
        },
        { label: 'Status', cell: (c) => (c.blocked ? pill('blocked', 'bad') : el('span', { class: 'muted' }, 'ok')) },
        { label: 'Resets', cell: (c) => when(c.resetsAt) },
        {
          label: '', cls: 'actions', cell: (c) => button('Reset', 'unlock', act('…', async (busy) => {
            const ok = await confirmDialog({
              title: 'Reset this counter?',
              message: c.blocked ? 'This lets them in again right away.' : 'The count starts again from zero.',
              confirmLabel: 'Reset',
            });
            if (!ok) return;
            await busy(() => api(`/api/admin/ratelimits/${encodeURIComponent(c.key)}`, { method: 'DELETE' }));
            toast('Counter reset');
            await reload();
          }), 'ghost small'),
        },
      ], data.counters, { emptyNode: empty('shieldCheck', 'All quiet', 'No sign-ups or failed logins in the current windows.') })),
    el('div', { class: 'card' },
      el('h3', { class: 'with-icon' }, aicon('shield', { size: 20 }), 'How accounts are protected'),
      el('ul', { class: 'muted', style: 'margin:10px 0 0;padding-left:20px;line-height:1.7' },
        el('li', {}, 'Passwords are stored as bcrypt hashes; nobody, admins included, can read them. Use Reset password on a player page to give someone a temporary one.'),
        el('li', {}, 'Logins last 7 days. Sign out everywhere ends every session of a player at once; a ban also kicks them out of their game.'),
        el('li', {}, 'Account counters only keep a hash of the email typed, so attempts on emails nobody registered stay anonymous.'),
        el('li', {}, 'Every change made from this panel is recorded in the Activity log.'))));
  return undefined;
}
