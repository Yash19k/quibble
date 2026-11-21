// The announcement banner: one short message every player sees at the top of the game page (maintenance, events).
import { api, el, toast, confirmDialog } from '../common.js';
import { aicon } from './icons.js';
import { pageHead, segmented, act, loading, failed, when, dateTime, fill,
} from './ui.js';

const MAX = 280;

/** The banner as the play page draws it (js/announce.js). */
export const bannerPreview = (text, tone) => el('div', { class: `banner ${tone === 'warn' ? 'warn' : 'info'} with-icon announce-preview` },
  aicon(tone === 'warn' ? 'alert' : 'megaphone'), el('span', {}, text));

export async function render(body, args, ctx) {
  let current;
  loading(body);
  try {
    ({ announcement: current } = await api('/api/admin/announcement'));
  } catch (err) {
    return failed(body, err, () => render(body, args, ctx));
  }
  if (!ctx.isCurrent()) return undefined;

  let tone = current?.tone ?? 'info';
  const text = el('textarea', { id: 'ann-text', rows: 3, maxlength: MAX, placeholder: 'e.g. Quiz night starts at 8 pm. Join with the code on the screen!' }, current?.text ?? '');
  const counter = el('span', { class: 'hint', style: 'margin:0' });
  const preview = el('div');
  const toneBox = el('div');
  const paint = () => {
    const t = text.value.trim();
    counter.textContent = `${text.value.length} / ${MAX}`;
    fill(preview, t ? bannerPreview(t, tone) : el('p', { class: 'muted' }, 'Type a message to see the preview.'));
    fill(toneBox, segmented([['info', 'Info'], ['warn', 'Warning']], tone, (v) => { tone = v; paint(); }, 'Tone'));
  };
  text.addEventListener('input', paint);
  paint();

  const publish = el('button', {
    type: 'button', class: 'with-icon',
    onclick: act('Publishing…', async () => {
      const t = text.value.trim();
      if (t.length < 3) return toast('Write at least a few words.');
      await api('/api/admin/announcement', { method: 'PUT', body: { text: t, tone } });
      toast('Announcement published');
      await render(body, args, ctx);
    }),
  }, aicon('megaphone', { size: 16 }), current ? 'Update announcement' : 'Publish');
  const remove = current ? el('button', {
    type: 'button', class: 'ghost danger with-icon',
    onclick: act('Removing…', async (busy) => {
      const ok = await confirmDialog({ title: 'Take the announcement down?', message: 'Players stop seeing it within a few seconds.', confirmLabel: 'Take down', danger: true });
      if (!ok) return;
      await busy(() => api('/api/admin/announcement', { method: 'DELETE' }));
      toast('Announcement removed');
      await render(body, args, ctx);
    }),
  }, aicon('trash', { size: 16 }), 'Take down') : null;

  fill(body,
    pageHead('Announcement', 'One short message shown to every player at the top of the game page, until you take it down. Players can hide it for their visit.'),
    el('div', { class: 'grid2' },
      el('div', { class: 'card' },
        el('h3', {}, current ? 'Edit the announcement' : 'New announcement'),
        el('label', { for: 'ann-text' }, 'Message'), text,
        el('div', { class: 'row', style: 'justify-content:space-between;margin-top:6px' }, counter),
        el('label', {}, 'Tone'), toneBox,
        el('div', { class: 'row', style: 'margin-top:20px' }, publish, remove)),
      el('div', { class: 'card' },
        el('h3', {}, 'Preview'),
        preview,
        el('p', { class: 'hint' }, current
          ? ['Showing now. Last changed ', el('span', { title: dateTime(current.updatedAt) }, when(current.updatedAt)), current.updatedBy ? ` by ${current.updatedBy}` : '', '.']
          : 'Nothing is showing to players right now.'))));
  text.focus();
  return undefined;
}
