// The announcement admins post (admin.html#/announcement), shown above the game on play.html. Fetched once per page
// load and silently skipped if the API is slow or down. Hiding it lasts for this browser session; a new message
// (new id) shows again.
import { API_URL, el, session } from './common.js';
import { aicon } from './admin/icons.js';

const HIDDEN_KEY = 'quibble.announcement.hidden';

async function showAnnouncement() {
  const slot = document.getElementById('announce');
  if (!slot) return;
  let a = null;
  try {
    const res = await fetch(`${API_URL}/api/announcement`, { signal: AbortSignal.timeout(5000), cache: 'no-store' });
    if (res.ok) ({ announcement: a } = await res.json());
  } catch {
    return; // a banner is never worth an error
  }
  if (!a?.text || session.get(HIDDEN_KEY) === a.id) return;
  const warn = a.tone === 'warn';
  const hide = el('button', {
    type: 'button', class: 'ghost small icon-btn', 'aria-label': 'Hide this message', title: 'Hide',
    onclick: () => {
      session.set(HIDDEN_KEY, a.id);
      slot.replaceChildren();
      slot.hidden = true;
    },
  }, aicon('x', { size: 15 }));
  slot.replaceChildren(el('div', { class: `banner ${warn ? 'warn' : 'info'} with-icon`, role: 'status', style: 'margin:0' },
    aicon(warn ? 'alert' : 'megaphone'), el('span', {}, a.text), hide));
  slot.hidden = false;
}

showAnnouncement();
