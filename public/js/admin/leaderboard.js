// Leaderboards exactly as players see them (all time / this week), with a button to recompute them now.
import { api, el, toast } from '../common.js';
import { pageHead, dataTable, segmented, button, act, loading, failed, empty, num, rankColumn, fill,
} from './ui.js';

const PERIODS = [['all', 'All time'], ['week', 'This week']];
let period = 'all';

export async function render(body, args, ctx) {
  let rows;
  loading(body);
  try {
    ({ leaderboard: rows } = await api(`/api/admin/leaderboard?period=${period}`));
  } catch (err) {
    return failed(body, err, () => render(body, args, ctx));
  }
  if (!ctx.isCurrent()) return undefined;
  fill(body,
    pageHead('Leaderboards', 'The top 100, as players see them. Banned players are left out; boards update when a game ends.',
      segmented(PERIODS, period, (v) => { period = v; render(body, args, ctx); }, 'Period'),
      button('Recompute now', 'refresh', act('Recomputing…', async () => {
        const res = await api('/api/admin/leaderboard/refresh', { method: 'POST' });
        toast(`Leaderboards recomputed (${num(res.players)} players)`);
        await render(body, args, ctx);
      }), 'ghost')),
    el('div', { class: 'card flush' },
      dataTable([
        rankColumn((r) => r.rank),
        { label: 'Player', cell: (r) => el('span', { class: 'cell-main' }, r.username) },
        { label: 'Points', num: true, cell: (r) => num(r.totalScore) },
        { label: 'Games', num: true, cell: (r) => num(r.gamesPlayed) },
        { label: 'Wins', num: true, cell: (r) => num(r.wins) },
        { label: 'Right answers', num: true, cell: (r) => num(r.correctAnswers) },
      ], rows, { emptyNode: empty('trophy', period === 'week' ? 'No games this week' : 'No finished games yet') })));
  return undefined;
}
