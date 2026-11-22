// Landing page "How it works": step through one game, a moment at a time, and light up the AWS services that do the
// work, hop by hop. It plays through once by itself when scrolled into view and stops as soon as someone picks a step.
// The full hands-on tour is how-it-works.html.
(function () {
  var STEPS = [
    {
      chain: [['Your browser', 'phone or laptop'], ['Amazon S3', 'website bucket'], ['Your browser', 'runs the game app']],
      title: 'The website is just files',
      body: 'The pages, styles and scripts sit in an S3 bucket, and S3 hands them to your browser. A small config.js, written when the site is published, tells the app where Quibble’s two APIs live. Nothing runs until somebody plays.',
      code: 'aws/scripts/publish-frontend.mjs',
    },
    {
      chain: [['Your browser', 'HTTPS request'], ['API Gateway', 'HTTP API'], ['Lambda', 'api function'], ['DynamoDB', 'Users table']],
      title: 'One request, one Lambda',
      body: 'Logging in is an ordinary HTTPS request. API Gateway starts the api Lambda, which checks your password against the hash in the Users table and hands back a signed token. Once it has answered, the function stops, and so does the bill.',
      code: 'aws/backend/src/handlers/http.js',
    },
    {
      chain: [['Your browser', 'opens a WebSocket'], ['API Gateway', 'WebSocket API'], ['Lambda', 'ws-connect'], ['DynamoDB', 'Connections table']],
      title: 'A connection that stays open',
      body: 'Your phone opens one WebSocket for the whole game. ws-connect checks your token and saves the connection id so Quibble can reach you later. Joining is a message on that socket, and a conditional write hands out the seats, so a room never goes past 250 players.',
      code: 'aws/backend/src/handlers/wsConnect.js',
    },
    {
      chain: [['Lambda', 'game-timer'], ['DynamoDB', 'who is in the room'], ['API Gateway', 'PostToConnection'], ['Every phone', 'at the same moment']],
      title: 'A clock with no server',
      body: 'A Lambda can’t keep a timer running between requests, so Quibble invokes a game-timer Lambda asynchronously. It waits for the deadline, looks up who is in the room and pushes the next question to every phone through API Gateway.',
      code: 'aws/backend/src/lib/timer.js',
    },
    {
      chain: [['Your browser', 'taps an answer'], ['API Gateway', 'stamps the time'], ['Lambda', 'ws-message'], ['DynamoDB', 'GamePlay table']],
      title: 'Speed is timed by AWS, not your phone',
      body: 'Your answer goes up the open socket. ws-message times it with API Gateway’s own clock, so nobody can fake a fast tap, and saves it with a conditional write, so a retry on a shaky connection can’t count twice.',
      code: 'event.requestContext.requestTimeEpoch',
    },
    {
      chain: [['Every Lambda', 'logs and metrics'], ['CloudWatch', '14 alarms'], ['Amazon SNS', 'alerts topic'], ['Your inbox', 'an email']],
      title: 'Someone gets an email',
      body: 'Every function writes logs and metrics to CloudWatch, and a monitor Lambda checks the site every minute. When an alarm trips on errors, throttling or a failed health check, SNS emails the owner.',
      code: 'aws/template.yaml',
    },
  ];

  var card = document.querySelector('.hop-card');
  if (!card) return;
  var tabs = Array.prototype.slice.call(card.querySelectorAll('.hop-tab'));
  var stage = document.getElementById('hop-stage');
  var chain = document.getElementById('hop-chain');
  var text = document.getElementById('hop-text');
  var title = document.getElementById('hop-title');
  var body = document.getElementById('hop-body');
  var code = document.getElementById('hop-code');
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var cur = 0;
  var run = 0; // bumps on every render so stale light-up timers do nothing
  var auto = !reduce; // stops for good once someone picks a step
  var paused = false;
  var visible = false;
  var timer = 0;
  var HOP_MS = 280;
  var DWELL_MS = 6500;

  function el(tag, cls, txt) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt) n.textContent = txt;
    return n;
  }

  function render(i, animate) {
    var mine = ++run;
    var s = STEPS[i];
    chain.textContent = '';
    s.chain.forEach(function (hop, k) {
      if (k) chain.appendChild(el('li', 'hop-arrow')).setAttribute('aria-hidden', 'true');
      var li = el('li', 'hop-node');
      li.appendChild(el('b', '', hop[0]));
      li.appendChild(el('span', '', hop[1]));
      chain.appendChild(li);
    });
    title.textContent = s.title;
    body.textContent = s.body;
    code.textContent = s.code;
    tabs.forEach(function (t, k) {
      t.setAttribute('aria-selected', String(k === i));
      t.tabIndex = k === i ? 0 : -1;
    });
    stage.setAttribute('aria-labelledby', tabs[i].id);

    var items = Array.prototype.slice.call(chain.children);
    if (!animate || reduce) {
      items.forEach(function (n) { n.classList.add('lit'); });
      return;
    }
    text.classList.remove('in');
    void text.offsetWidth; // restart the fade
    text.classList.add('in');
    items.forEach(function (n, k) {
      setTimeout(function () { if (mine === run) n.classList.add('lit'); }, 120 + k * HOP_MS);
    });
  }

  function show(i, animate) {
    cur = (i + STEPS.length) % STEPS.length;
    render(cur, animate);
  }

  function schedule() {
    clearTimeout(timer);
    if (!auto || paused || !visible) return;
    timer = setTimeout(function () {
      var next = (cur + 1) % STEPS.length;
      show(next, true);
      if (next === 0) auto = false; // one lap, then it waits for the visitor
      else schedule();
    }, DWELL_MS);
  }

  function pick(i, focus) {
    auto = false;
    clearTimeout(timer);
    show(i, true);
    if (focus) tabs[cur].focus();
  }

  tabs.forEach(function (t, k) {
    t.addEventListener('click', function () { pick(k, false); });
    t.addEventListener('keydown', function (e) {
      var to = { ArrowRight: cur + 1, ArrowDown: cur + 1, ArrowLeft: cur - 1, ArrowUp: cur - 1, Home: 0, End: STEPS.length - 1 }[e.key];
      if (to === undefined) return;
      e.preventDefault();
      pick(to, true);
    });
  });

  // Hold still while the visitor is reading or using it.
  card.addEventListener('mouseenter', function () { paused = true; clearTimeout(timer); });
  card.addEventListener('mouseleave', function () { paused = false; schedule(); });
  card.addEventListener('focusin', function () { paused = true; clearTimeout(timer); });
  card.addEventListener('focusout', function (e) { if (!card.contains(e.relatedTarget)) { paused = false; schedule(); } });

  show(0, false);

  if (!('IntersectionObserver' in window)) return;
  var seen = false;
  new IntersectionObserver(function (entries) {
    visible = entries[0].isIntersecting;
    if (visible && !seen) {
      seen = true;
      if (!reduce) render(cur, true); // replay the hops now that someone can see them
    }
    if (visible) schedule(); else clearTimeout(timer);
  }, { threshold: 0.45 }).observe(card);
})();
