// deploy.html: the deploy guide's small bits of behaviour. Purely client-side, never calls the API.
//   - copy buttons on every terminal block
//   - the PowerShell / bash picker (remembered)
//   - a "Done" checkbox per step, saved in this browser, mirrored in the contents rail and the progress bar
//   - the contents rail: highlights the section in view, opens and closes as a bar on narrow screens
//   - a link to a troubleshooting item opens it
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const DONE_KEY = 'quibble.deploy.done';
  const SHELL_KEY = 'quibble.deploy.shell';
  // localStorage can be missing or throw (private windows, blocked storage): the page works without it.
  const read = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const write = (k, v) => { try { localStorage.setItem(k, v); } catch { /* this visit only */ } };

  // ---------- terminal blocks: dim comments, colour [ok] / [warn] / [FAIL] in sample output ----------
  $$('.term code').forEach((code) => {
    const out = code.closest('.term').classList.contains('out');
    code.innerHTML = code.textContent.split('\n').map((line) => {
      if (out) {
        return esc(line).replace(/\[(ok|warn|FAIL)\]/, (m, w) => `<span class="${w === 'ok' ? 'ok' : w === 'warn' ? 'warn' : 'bad'}">${m}</span>`);
      }
      // A whole-line comment, or " # ..." after a command. "#" inside a word or URL is left alone.
      const m = /^(\s*)(#.*)$/.exec(line) || /^(.*?\s)(#\s.*)$/.exec(line);
      return m ? `${esc(m[1])}<span class="c">${esc(m[2])}</span>` : esc(line);
    }).join('\n');
  });

  // ---------- copy buttons ----------
  $$('.term .copy').forEach((btn) => {
    const label = btn.querySelector('span');
    btn.addEventListener('click', () => {
      const code = btn.closest('.term').querySelector('code');
      const text = code.textContent.replace(/\s+$/, '');
      const done = (ok) => {
        label.textContent = ok ? 'Copied' : 'Selected';
        btn.classList.toggle('ok', ok);
        clearTimeout(btn._t);
        btn._t = setTimeout(() => { label.textContent = 'Copy'; btn.classList.remove('ok'); }, 1600);
      };
      const select = () => {
        const r = document.createRange();
        r.selectNodeContents(code);
        const s = getSelection();
        s.removeAllRanges();
        s.addRange(r);
        done(false);
      };
      try { navigator.clipboard.writeText(text).then(() => done(true), select); } catch { select(); }
    });
  });

  // ---------- PowerShell / bash ----------
  const root = document.documentElement;
  const pickers = $$('[data-shell-pick]');
  function setShell(shell) {
    root.classList.toggle('shell-ps', shell === 'ps');
    root.classList.toggle('shell-sh', shell === 'sh');
    pickers.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.shellPick === shell)));
  }
  setShell(read(SHELL_KEY) === 'sh' ? 'sh' : 'ps');
  pickers.forEach((b) => b.addEventListener('click', () => {
    setShell(b.dataset.shellPick);
    write(SHELL_KEY, b.dataset.shellPick);
  }));

  // ---------- step progress ----------
  const boxes = $$('.done input[data-step]');
  const total = boxes.length;
  const bar = $('#prog-bar');
  const reset = $('#prog-reset');
  let undo = null; // the steps a reset cleared, while its Undo is offered

  function loadDone() {
    try {
      const list = JSON.parse(read(DONE_KEY) || '[]');
      return new Set(Array.isArray(list) ? list.filter((s) => typeof s === 'string') : []);
    } catch { return new Set(); }
  }
  function apply(done, save = true) {
    boxes.forEach((b) => {
      const on = done.has(b.dataset.step);
      b.checked = on;
      $(`.step[data-step="${b.dataset.step}"]`)?.classList.toggle('is-done', on);
      $(`.toc-list li[data-step="${b.dataset.step}"]`)?.classList.toggle('is-done', on);
    });
    const n = boxes.filter((b) => b.checked).length;
    const text = `${n} of ${total} steps done`;
    $$('[data-prog-long], [data-prog-short]').forEach((el) => { el.textContent = text; });
    bar.setAttribute('aria-valuenow', String(n));
    bar.firstElementChild.style.width = `${(n / total) * 100}%`;
    if (!undo) reset.disabled = n === 0;
    if (save) write(DONE_KEY, JSON.stringify([...done]));
  }
  const current = () => new Set(boxes.filter((b) => b.checked).map((b) => b.dataset.step));

  apply(loadDone(), false);
  boxes.forEach((b) => b.addEventListener('change', () => {
    if (undo) endUndo();
    apply(current());
  }));

  // Reset without a confirm dialog: it clears at once and offers Undo for a few seconds instead.
  function endUndo() {
    clearTimeout(undo.timer);
    undo = null;
    reset.textContent = 'Reset';
    apply(current(), false);
  }
  reset.addEventListener('click', () => {
    if (undo) {
      const before = undo.before;
      endUndo();
      apply(before);
      return;
    }
    const before = current();
    if (!before.size) return;
    apply(new Set());
    undo = { before, timer: setTimeout(endUndo, 6000) };
    reset.disabled = false;
    reset.textContent = 'Undo';
  });

  // ---------- contents rail ----------
  const toc = $('#toc');
  const toggle = $('#toc-toggle');
  const narrow = matchMedia('(max-width: 1000px)');
  toc.classList.add('js');
  function setOpen(open) {
    toc.classList.toggle('open', open);
    toggle.setAttribute('aria-expanded', String(open));
  }
  toggle.addEventListener('click', () => setOpen(!toc.classList.contains('open')));
  $$('.toc-list a').forEach((a) => a.addEventListener('click', () => { if (narrow.matches) setOpen(false); }));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && toc.classList.contains('open')) { setOpen(false); toggle.focus(); }
  });
  document.addEventListener('click', (e) => {
    if (toc.classList.contains('open') && !toc.contains(e.target)) setOpen(false);
  });
  narrow.addEventListener('change', () => setOpen(false));

  // Highlight the section being read: the last one whose top has scrolled past a line near the top of the screen.
  const links = $$('.toc-list a');
  const targets = links.map((a) => document.getElementById(a.getAttribute('href').slice(1)));
  let ticking = false;
  function markCurrent() {
    ticking = false;
    const line = innerHeight * 0.3;
    let cur = -1;
    targets.forEach((t, i) => { if (t && t.getBoundingClientRect().top <= line) cur = i; });
    links.forEach((a, i) => {
      if (i === cur) a.setAttribute('aria-current', 'true');
      else a.removeAttribute('aria-current');
    });
  }
  addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(markCurrent); } }, { passive: true });
  addEventListener('resize', markCurrent);
  markCurrent();

  // ---------- a link straight to a troubleshooting item opens it ----------
  function openTarget() {
    const id = decodeURIComponent(location.hash.slice(1));
    const el = id && document.getElementById(id);
    if (el && el.tagName === 'DETAILS') el.open = true;
  }
  addEventListener('hashchange', openTarget);
  openTarget();
})();
