// Landing page: logged-in visitors skip straight to their lobby; the hero card's demo countdown.
(function () {
  var signedIn = false;
  try { signedIn = !!localStorage.getItem('quibble.token'); } catch (e) {}
  if (signedIn) {
    document.querySelectorAll('[data-auth="out"]').forEach(function (n) { n.remove(); });
    document.querySelectorAll('[data-cta]').forEach(function (n) { n.textContent = 'Go to lobby'; });
  }
  // Demo countdown in the hero card.
  var t = document.getElementById('demo-timer'), bar = document.getElementById('demo-bar');
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  var left = 15;
  setInterval(function () {
    left = left <= 0 ? 15 : left - 1;
    t.textContent = left;
    bar.style.transform = 'scaleX(' + left / 15 + ')';
  }, 1000);
})();
