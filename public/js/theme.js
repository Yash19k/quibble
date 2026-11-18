// Light/dark theme. Loaded as a plain script in <head> so the saved theme is applied
// before the first paint (no flash). With no saved choice the site follows the system.
(function () {
  var KEY = 'quibble.theme';
  var root = document.documentElement;
  var media = window.matchMedia('(prefers-color-scheme: dark)');

  function saved() {
    try { return localStorage.getItem(KEY); } catch (e) { return null; }
  }
  var choice = saved();
  if (choice === 'light' || choice === 'dark') root.setAttribute('data-theme', choice);

  function current() {
    return root.getAttribute('data-theme') || (media.matches ? 'dark' : 'light');
  }

  var SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
  var MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11z"/></svg>';

  function paint(btn) {
    var dark = current() === 'dark';
    // Show the theme you'd switch TO.
    btn.innerHTML = dark ? SUN : MOON;
    btn.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
    btn.title = btn.getAttribute('aria-label');
  }

  function mount() {
    var header = document.querySelector('header.top');
    if (!header) return;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ghost theme-toggle';
    btn.addEventListener('click', function () {
      var next = current() === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      try { localStorage.setItem(KEY, next); } catch (e) {}
      paint(btn);
    });
    // Sits between the logo and the nav (the nav is re-rendered by app.js, so stay outside it).
    header.insertBefore(btn, header.querySelector('nav'));
    paint(btn);
    media.addEventListener('change', function () { paint(btn); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
