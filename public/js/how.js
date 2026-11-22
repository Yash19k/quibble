// how-it-works.html: the five hands-on stations (request explorer, scoring, retries, burst simulator, AWS quiz).
// Purely client-side: it never calls the API. Code samples come from the <script type="text/plain"> blocks in the page.
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const snip = (id) => (document.getElementById(id)?.textContent || '').replace(/^\n+/, '').replace(/\s+$/, '');
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const fmt = (n) => Math.round(n).toLocaleString('en-US');

  // ---------- tiny highlighter: comments, strings, keywords ----------
  const RE = {
    js: /(\/\/[^\n]*)|('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`)|\b(const|let|await|async|return|if|new|export|import|from|function|throw|true|false|null|try|catch)\b/g,
    yaml: /(#[^\n]*)|('[^'\n]*'|"[^"\n]*")|(![A-Za-z]+|\b(?:true|false)\b)/g,
    json: /(\/\/[^\n]*)|("(?:[^"\\\n]|\\.)*")|\b(true|false|null)\b/g,
  };
  function hl(code, lang) {
    const re = RE[lang];
    if (!re) return esc(code);
    re.lastIndex = 0;
    let out = '', last = 0, m;
    while ((m = re.exec(code))) {
      if (m[0] === '') { re.lastIndex++; continue; }
      out += esc(code.slice(last, m.index));
      out += `<span class="${m[1] ? 'c' : m[2] ? 's' : 'k'}">${esc(m[0])}</span>`;
      last = re.lastIndex;
    }
    return out + esc(code.slice(last));
  }
  const langOf = (id) => {
    const t = snip(id);
    if (/^#|^[A-Z][A-Za-z]+:\s*$/m.test(t.split('\n')[0]) || /^\s*Type: AWS/m.test(t)) return 'yaml';
    if (/^POST /.test(t)) return 'text';
    if (/^\/\/[^\n]*\n\{/.test(t) || /^\{/.test(t)) return 'json';
    return 'js';
  };
  const showCode = (el, id) => { el.innerHTML = hl(snip(id), langOf(id)); };

  // =====================================================================
  // Station 1: follow a request
  // =====================================================================
  const S = {
    open: { name: 'Open the site', steps: [
      { t: 'The phone asks S3 for the page', b: 'Opening the link fetches <code>play.html</code>, the CSS and the JavaScript straight from an S3 bucket over HTTPS. Nothing is running for this: S3 just hands out files.',
        go: [['e-browser-s3', 0, 'GET /play.html']], on: ['browser', 's3'], code: 'c-policy' },
      { t: 'config.js says where the APIs live', b: 'The API addresses only exist after a deploy, so they can’t be typed into the code. The deploy script reads the stack’s outputs and writes a tiny <code>config.js</code>, so the same code works for any copy of the stack, including yours.',
        go: [['e-browser-s3', 1, 'config.js']], on: ['browser', 's3'], code: 'c-config' },
    ] },
    signup: { name: 'Sign up', steps: [
      { t: 'The page calls the HTTP API', b: 'The sign-up form sends one HTTPS request. API Gateway checks it comes from an allowed site (CORS) and that traffic is under 1,000 requests a second, then hands it to Lambda.',
        go: [['e-browser-http', 0, 'POST /api/auth/register']], on: ['browser', 'http'], code: 'c-register' },
      { t: 'The api function checks the input', b: 'One Lambda serves every <code>/api/*</code> route. Before anything else runs, a zod schema rejects a bad email, a short password or a strange username.',
        go: [['e-http-api', 0, 'event']], on: ['http', 'api'], code: 'c-schema' },
      { t: 'Count the sign-up against the network', b: 'A counter in the RateLimits table goes up by one, but only while it’s under 500 sign-ups per network per hour. That’s high enough for a whole classroom on one Wi-Fi. TTL deletes old counters.',
        go: [['e-api-ddb', 0, 'ADD hits']], on: ['api', 'ddb'], tables: ['RateLimits'], code: 'c-ratelimit' },
      { t: 'Save the user, keep the email unique', b: 'DynamoDB has no UNIQUE constraint, so sign-up writes three items in one transaction: the user plus an email guard and a username guard. If either is taken, nothing is saved.',
        go: [['e-api-ddb', 0, 'TransactWrite']], on: ['api', 'ddb'], tables: ['Users'], code: 'c-guards' },
      { t: 'A signed token comes back', b: 'The function signs a JWT that lasts 7 days and returns it. The page keeps it and sends it with every later request, so no session needs to be stored anywhere.',
        go: [['e-http-api', 1, 'token'], ['e-browser-http', 1, '201 + token']], on: ['browser', 'http', 'api'], code: 'c-token' },
    ] },
    join: { name: 'Join a game', steps: [
      { t: 'Open a WebSocket', b: 'For live play the page opens a WebSocket and keeps it open. API Gateway holds the connection and gives it a <code>connectionId</code>.',
        go: [['e-browser-ws', 0, 'wss://…?token=']], on: ['browser', 'ws'], code: 'c-wsopen' },
      { t: 'ws-connect checks who it is', b: 'The <code>$connect</code> route runs ws-connect. It verifies the token, reads the user, and saves the socket. Returning 401 would make API Gateway refuse the connection.',
        go: [['e-ws-connect', 0, '$connect'], ['e-connect-ddb', 0, 'save socket']], on: ['ws', 'connect', 'ddb'], tables: ['Users', 'Connections'], code: 'c-connect' },
      { t: 'Send room:join', b: 'Every later message goes to the <code>$default</code> route, which runs ws-message. Each message carries an <code>id</code> so the server can acknowledge exactly that message.',
        go: [['e-browser-ws', 0, 'room:join'], ['e-ws-message', 0, '$default']], on: ['browser', 'ws', 'message'], code: 'c-joinmsg' },
      { t: 'Take a seat', b: 'ws-message reads the game’s header, then takes a seat at the lobby gate with one conditional update. Two players can never get the same seat, and the game never goes past 250 players.',
        go: [['e-message-ddb', 0, 'ADD #seq']], on: ['message', 'ddb'], tables: ['Games', 'GamePlay'], code: 'c-seat' },
      { t: 'An ack, then everyone sees you', b: 'ws-message replies with an ack for that message id. Then the lobby list is pushed to every player, batched to at most once every 500 ms per game so a full room doesn’t flood anyone.',
        go: [['e-ws-message', 1, 'ack'], ['e-browser-ws', 1, 'room:state']], on: ['browser', 'ws', 'message'], code: 'c-push' },
    ] },
    answer: { name: 'Answer a question', steps: [
      { t: 'Tap an answer', b: 'The page sends only the choice. It never knows the right answer, so there’s nothing in the browser to cheat with.',
        go: [['e-browser-ws', 0, 'answer:submit'], ['e-ws-message', 0, '$default']], on: ['browser', 'ws', 'message'], code: 'c-answermsg' },
      { t: 'Stamp the arrival time', b: 'Speed is measured from <code>requestTimeEpoch</code>, the moment API Gateway received the message, not when Lambda got around to it. A slow start never costs a player points.',
        go: [], on: ['ws', 'message'], code: 'c-arrival' },
      { t: 'Save the answer, once', b: 'The answer goes to its own partition key, <code>&lt;code&gt;#A#&lt;question&gt;</code>, only if this seat hasn’t answered yet. A resend fails the condition and the first arrival time is kept.',
        go: [['e-message-ddb', 0, 'Put answer']], on: ['message', 'ddb'], tables: ['GamePlay'], code: 'c-answerput' },
      { t: 'Count it at the question’s gate', b: 'One small gate item per question counts answers. The update only lands while the question is open and if this seat isn’t counted yet. When everyone has answered, the question closes early.',
        go: [['e-message-ddb', 0, 'ADD #answered']], on: ['message', 'ddb'], tables: ['GamePlay'], code: 'c-gate' },
      { t: 'Locked in', b: 'The ack tells the page the answer is locked. The score stays secret until the question closes for everyone.',
        go: [['e-ws-message', 1, 'ack'], ['e-browser-ws', 1, 'locked']], on: ['browser', 'ws', 'message'], code: 'c-ack' },
    ] },
    timer: { name: 'Time’s up', steps: [
      { t: 'Opening a question starts a timer', b: 'A Lambda can’t sleep for 20 seconds between requests. So whoever opens a question also starts game-timer asynchronously, with the deadline in the payload.',
        go: [['e-message-timer', 0, 'Invoke (Event)']], on: ['message', 'timer'], code: 'c-invoke' },
      { t: 'Live answer counts', b: 'While the question is open, the timer pushes “12 of 30 answered” to every phone about once a second.',
        go: [['e-timer-ws', 0, 'answer:count'], ['e-browser-ws', 1, '12 of 30']], on: ['timer', 'ws', 'browser'], code: 'c-count' },
      { t: 'Close the question, exactly once', b: 'At the deadline the timer closes the question with a transaction guarded by the game’s version number. If two timers fire, exactly one wins and the other does nothing.',
        go: [['e-timer-ddb', 0, 'version 7 → 8']], on: ['timer', 'ddb'], tables: ['Games', 'GamePlay'], code: 'c-version' },
      { t: 'Results to every phone', b: 'Lambda doesn’t hold sockets, so it calls API Gateway’s <code>PostToConnection</code> once per player. With 250 players that’s 250 small calls, sent in parallel.',
        go: [['e-timer-ws', 0, 'PostToConnection'], ['e-browser-ws', 1, 'question:result']], on: ['timer', 'ws', 'browser'], code: 'c-push' },
      { t: 'The timer starts the next timer', b: 'After the results pause, the next timer opens question 2, and so on to the end. Because the function keeps invoking itself, the template sets <code>RecursiveLoop: Allow</code>; otherwise Lambda stops the chain after about 16 hops, mid-game.',
        go: [], on: ['timer'], pulse: ['timer'], code: 'c-recursive' },
    ] },
    alert: { name: 'Something breaks', steps: [
      { t: 'Every minute, a health check', b: 'An EventBridge schedule runs the monitor function once a minute. A second rule catches CloudFormation’s “deploy failed” events.',
        go: [['e-eb-monitor', 0, 'rate(1 minute)']], on: ['eb', 'monitor'], code: 'c-schedule' },
      { t: 'Probe the site, the API and the sockets', b: 'The monitor loads <code>index.html</code> from S3, calls <code>/api/health</code> (which reads DynamoDB), and opens a WebSocket that a healthy <code>$connect</code> refuses with 401.',
        go: [], on: ['monitor', 's3', 'http', 'ws', 'ddb'], pulse: ['s3', 'http', 'ws'], code: 'c-probe' },
      { t: 'Record pass or fail', b: 'It writes <code>HealthCheckFailed</code> as 0 or 1 using CloudWatch’s Embedded Metric Format: a log line in a special shape that CloudWatch turns into a metric. No extra API call needed.',
        go: [['e-cw-monitor', 1, 'HealthCheckFailed = 1']], on: ['monitor', 'cw'], code: 'c-emf' },
      { t: 'Two bad minutes trip the alarm', b: 'The alarm fires when 2 of the last 3 minutes failed, so one blip doesn’t wake anyone. Its action invokes the monitor directly.',
        go: [['e-cw-monitor', 0, 'ALARM']], on: ['cw', 'monitor'], code: 'c-alarm' },
      { t: 'An email in plain language', b: 'The monitor writes a readable message, with the error lines it found in the logs, and publishes it to an SNS topic. SNS emails every confirmed subscriber. When the alarm clears, a “back up” email follows.',
        go: [['e-monitor-sns', 0, 'Publish']], on: ['monitor', 'sns'], code: 'c-sns' },
    ] },
  };
  const ORDER = ['open', 'signup', 'join', 'answer', 'timer', 'alert'];

  const INFO = {
    browser: { t: 'The player’s browser', b: 'Plain HTML, CSS and JavaScript with no framework and no build step. <code>js/net.js</code> retries REST calls with backoff; <code>js/realtime.js</code> keeps the socket open and resends anything that wasn’t acknowledged.', code: 'c-client', src: 'public/js/realtime.js' },
    s3: { t: 'Amazon S3', b: 'Holds the website files and serves them over HTTPS. Buckets are private by default; this one gets a policy that lets anyone read, and nobody write.', code: 'c-policy', src: 'aws/template.yaml' },
    http: { t: 'API Gateway HTTP API', b: 'The HTTPS front door for <code>/api/*</code>: sign-up, login, leaderboards, My quizzes and the admin console. It handles CORS and throttling before any of your code runs.', code: 'c-httpapi', src: 'aws/template.yaml' },
    ws: { t: 'API Gateway WebSocket API', b: 'Holds every player’s open connection, so no server has to. Three routes, <code>$connect</code>, <code>$default</code> and <code>$disconnect</code>, each run a Lambda.', code: 'c-wsapi', src: 'aws/template.yaml' },
    api: { t: 'The api function', b: 'One Lambda for all REST routes. It gets 1,769 MB of memory, which is one full vCPU, because hashing passwords with bcrypt is deliberately slow and a classroom may sign up at once.', code: 'c-routes', src: 'aws/backend/src/handlers/http.js' },
    connect: { t: 'The ws-connect function', b: 'Runs when a socket opens. It checks the login token and saves the connection; returning 401 makes API Gateway refuse the socket.', code: 'c-connect', src: 'aws/backend/src/handlers/wsConnect.js' },
    disconnect: { t: 'The ws-disconnect function', b: 'Runs when a socket closes. AWS only tries its best to send this event, so Quibble never depends on it: connection items also expire by TTL, and pages re-sync after reconnecting.', code: 'c-disconnect', src: 'aws/backend/src/handlers/wsDisconnect.js' },
    message: { t: 'The ws-message function', b: 'Every game action: create, join, start, answer, react. Each message is validated, run, and answered with an ack carrying the same id.', code: 'c-actions', src: 'aws/backend/src/handlers/wsMessage.js' },
    timer: { t: 'The game-timer function', b: 'Replaces <code>setTimeout</code>. Started asynchronously with a deadline, it waits, then closes the question or opens the next one. Every step is safe to run twice because Lambda may retry.', code: 'c-recursive', src: 'aws/template.yaml' },
    ddb: { t: 'Amazon DynamoDB', b: 'Nine on-demand tables: you pay per read and write, and nothing while idle. TTL deletes old games, sockets and counters by itself. Each table is a few lines of the template.', code: 'c-table', src: 'aws/template.yaml' },
    eb: { t: 'Amazon EventBridge', b: 'Runs the monitor function every minute, and passes it CloudFormation’s events when a deploy fails or rolls back.', code: 'c-schedule', src: 'aws/template.yaml' },
    cw: { t: 'Amazon CloudWatch', b: 'Every function’s logs (kept 14 days), custom metrics, 14 alarms and a dashboard. A metric filter counts error log lines, so even errors the code caught can raise an alarm.', code: 'c-filter', src: 'aws/template.yaml' },
    monitor: { t: 'The monitor function', b: 'Uptime probes every minute, and the writer of every alert email: alarms, failed deploys and a test email from <code>npm run alerts:test</code>.', code: 'c-monitor', src: 'aws/backend/src/handlers/monitor.js' },
    sns: { t: 'Amazon SNS', b: 'One topic, any number of email subscribers. AWS emails each address a “Confirm subscription” link first; after that, every alert arrives in the inbox.', code: 'c-sns', src: 'aws/template.yaml' },
  };
  const SRC = {
    'c-policy': 'aws/template.yaml', 'c-config': 'public/config.js (generated)', 'c-register': 'the HTTP request', 'c-schema': 'aws/backend/src/lib/schemas.js',
    'c-ratelimit': 'aws/backend/src/lib/ratelimit.js', 'c-guards': 'aws/backend/src/lib/users.js', 'c-token': 'aws/backend/src/lib/auth.js', 'c-wsopen': 'public/js/realtime.js',
    'c-connect': 'aws/backend/src/handlers/wsConnect.js', 'c-joinmsg': 'the WebSocket message', 'c-seat': 'aws/backend/src/lib/game.js', 'c-push': 'aws/backend/src/lib/push.js',
    'c-answermsg': 'the WebSocket message', 'c-arrival': 'aws/backend/src/handlers/wsMessage.js', 'c-answerput': 'aws/backend/src/lib/game.js', 'c-gate': 'aws/backend/src/lib/game.js',
    'c-ack': 'the WebSocket reply', 'c-invoke': 'aws/backend/src/lib/timer.js', 'c-count': 'the WebSocket push', 'c-version': 'aws/backend/src/lib/game.js', 'c-recursive': 'aws/template.yaml',
    'c-schedule': 'aws/template.yaml', 'c-probe': 'aws/backend/src/handlers/monitor.js', 'c-emf': 'aws/backend/src/lib/log.js', 'c-alarm': 'aws/template.yaml', 'c-sns': 'aws/template.yaml',
  };

  const svg = $('#dg');
  const pkt = $('#pkt');
  const pktT = $('#pkt-t');
  const P = { kicker: $('#p-kicker'), title: $('#p-title'), body: $('#p-body'), src: $('#p-src'), code: $('#p-code'), dots: $('#dots') };
  const cur = { sc: 'signup', i: 0 };
  let runId = 0;

  // scenario chips
  const chipBox = $('#scenarios');
  ORDER.forEach((k) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'chip'; b.dataset.sc = k; b.textContent = S[k].name;
    b.setAttribute('aria-pressed', String(k === cur.sc));
    b.addEventListener('click', () => { cur.sc = k; cur.i = 0; renderStep(); });
    chipBox.append(b);
  });

  function clearMarks() {
    $$('.node.on, .node.pulse', svg).forEach((n) => n.classList.remove('on', 'pulse'));
    $$('.edge.on', svg).forEach((e) => e.classList.remove('on'));
    $$('.tbl.on', svg).forEach((t) => t.classList.remove('on'));
    pkt.classList.add('gone');
    pktT.textContent = '';
  }
  function place(pt) {
    pkt.setAttribute('transform', `translate(${pt.x.toFixed(1)} ${pt.y.toFixed(1)})`);
    const left = pt.x > 760;
    pktT.setAttribute('x', left ? -13 : 13);
    pktT.setAttribute('text-anchor', left ? 'end' : 'start');
  }
  function travel(path, rev, id) {
    return new Promise((done) => {
      const len = path.getTotalLength();
      pkt.classList.remove('gone');
      // No motion: park the dot halfway along the wire.
      if (reduce.matches) { place(path.getPointAtLength(len / 2)); return done(); }
      const dur = Math.max(520, Math.min(1000, len * 3));
      const t0 = performance.now();
      const frame = (now) => {
        if (id !== runId) return done();
        const p = Math.min(1, (now - t0) / dur);
        const e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
        place(path.getPointAtLength((rev ? 1 - e : e) * len));
        if (p < 1) requestAnimationFrame(frame); else done();
      };
      requestAnimationFrame(frame);
    });
  }
  async function animate(st) {
    const id = ++runId;
    clearMarks();
    (st.on || []).forEach((n) => $('#n-' + n)?.classList.add('on'));
    (st.tables || []).forEach((t) => $('#t-' + t)?.classList.add('on'));
    if (!reduce.matches) (st.pulse || []).forEach((n) => { const el = $('#n-' + n); el?.classList.remove('pulse'); void el?.getBoundingClientRect(); el?.classList.add('pulse'); });
    for (const [edge, rev, label] of st.go || []) {
      if (id !== runId) return;
      const path = document.getElementById(edge);
      path.classList.add('on');
      // The label rides along only while the dot moves; a parked label would sit on top of a box.
      if (label && !reduce.matches) pktT.textContent = label;
      await travel(path, rev, id);
    }
    if (id === runId) pktT.textContent = ''; // arrived: the dot rests on the last box's edge
  }

  function renderStep() {
    const sc = S[cur.sc];
    const st = sc.steps[cur.i];
    $('#ctrl-step').hidden = false; $('#ctrl-info').hidden = true;
    $$('.chip', chipBox).forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.sc === cur.sc)));
    P.kicker.textContent = `${sc.name} · step ${cur.i + 1} of ${sc.steps.length}`;
    P.title.textContent = st.t;
    P.body.innerHTML = st.b;
    P.src.textContent = SRC[st.code] ? `From ${SRC[st.code]}` : '';
    showCode(P.code, st.code);
    P.dots.replaceChildren(...sc.steps.map((_, j) => {
      const d = document.createElement('button');
      d.type = 'button';
      d.className = j === cur.i ? 'cur' : j < cur.i ? 'done' : '';
      d.setAttribute('aria-label', `Step ${j + 1}`);
      d.addEventListener('click', () => { cur.i = j; renderStep(); });
      return d;
    }));
    $('#prev').disabled = cur.i === 0 && ORDER.indexOf(cur.sc) === 0;
    const lastStep = cur.i === sc.steps.length - 1;
    const nextSc = S[ORDER[ORDER.indexOf(cur.sc) + 1]];
    $('#next').firstChild.textContent = lastStep ? (nextSc ? `Next: ${nextSc.name}` : 'Start over') : 'Next';
    animate(st);
  }
  function step(d) {
    const sc = S[cur.sc];
    const n = cur.i + d;
    const k = ORDER.indexOf(cur.sc);
    if (n >= sc.steps.length) { cur.sc = ORDER[(k + 1) % ORDER.length]; cur.i = 0; }
    else if (n < 0) { if (k > 0) { cur.sc = ORDER[k - 1]; cur.i = S[cur.sc].steps.length - 1; } }
    else cur.i = n;
    renderStep();
  }
  $('#next').addEventListener('click', () => step(1));
  $('#prev').addEventListener('click', () => step(-1));
  $('#replay').addEventListener('click', () => animate(S[cur.sc].steps[cur.i]));
  $('#back-walk').addEventListener('click', renderStep);

  function showInfo(key) {
    const it = INFO[key];
    if (!it) return;
    runId++;
    clearMarks();
    $('#n-' + key).classList.add('on');
    $('#ctrl-step').hidden = true; $('#ctrl-info').hidden = false;
    P.kicker.textContent = 'About this piece';
    P.title.textContent = it.t;
    P.body.innerHTML = it.b;
    P.src.textContent = `From ${it.src}`;
    showCode(P.code, it.code);
  }
  $$('.node', svg).forEach((n) => {
    n.addEventListener('click', () => showInfo(n.dataset.node));
    n.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showInfo(n.dataset.node); } });
  });

  // start the walkthrough only once it's on screen, so the first animation is seen
  renderStep();
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { io.disconnect(); animate(S[cur.sc].steps[cur.i]); } }, { threshold: 0.35 });
    io.observe(svg);
  }

  // =====================================================================
  // Station 2: scoring
  // =====================================================================
  const LIMIT = 20000;
  const calculateScore = ({ correct, elapsedMs, timeLimitMs }) => {
    if (!correct) return 0;
    const ratio = Math.min(Math.max(elapsedMs / Math.max(1, timeLimitMs), 0), 1);
    return Math.round(1000 * (1 - ratio / 2));
  };
  const streakBonus = (s) => (s < 3 ? 0 : Math.min(500, (s - 3 + 1) * 100));
  showCode($('#sc-code'), 'c-score');
  let scRight = true;
  function renderScore() {
    const t = Number($('#sc-time').value);
    const streak = Number($('#sc-streak').value);
    $('#sc-time-out').textContent = `${t.toFixed(1)} s`;
    $('#sc-streak-out').textContent = String(streak);
    const base = calculateScore({ correct: scRight, elapsedMs: t * 1000, timeLimitMs: LIMIT });
    const bonus = scRight ? streakBonus(streak) : 0;
    $('#sc-total').textContent = fmt(base + bonus);
    $('#sc-split').textContent = scRight ? `${fmt(base)} speed + ${bonus} streak bonus` : 'Wrong answers score 0, and the streak resets';
    // chart
    const W = 560, H = 250, l = 54, r = 18, tp = 18, b = 40;
    const X = (s) => l + (s / 20) * (W - l - r);
    const Y = (p) => tp + (1 - p / 1000) * (H - tp - b);
    let g = '';
    [0, 250, 500, 750, 1000].forEach((p) => { g += `<line class="grid" x1="${l}" x2="${W - r}" y1="${Y(p)}" y2="${Y(p)}"/><text class="axis" x="${l - 8}" y="${Y(p) + 4}" text-anchor="end">${fmt(p)}</text>`; });
    [0, 5, 10, 15, 20].forEach((s) => { g += `<text class="axis" x="${X(s)}" y="${H - b + 20}" text-anchor="middle">${s} s</text>`; });
    g += `<text class="axis" x="${W - r}" y="${H - 4}" text-anchor="end">answer time</text>`;
    const area = `<path class="area" d="M${X(0)} ${Y(0)} L${X(0)} ${Y(1000)} L${X(20)} ${Y(500)} L${X(20)} ${Y(0)} Z"/>`;
    const curve = `<path class="curve" d="M${X(0)} ${Y(1000)} L${X(20)} ${Y(500)}"/>`;
    const zero = scRight ? '' : `<line class="zero" x1="${X(0)}" x2="${X(20)}" y1="${Y(0)}" y2="${Y(0)}"/>`;
    const px = X(t), py = Y(base);
    const tagLeft = px > W - 140;
    const tag = `<text class="tag" x="${px + (tagLeft ? -14 : 14)}" y="${py - 12}" text-anchor="${tagLeft ? 'end' : 'start'}">${fmt(base)} pts</text>`;
    $('#sc-chart').innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Points fall in a straight line from 1,000 for an instant answer to 500 at 20 seconds">${area}${g}${curve}${zero}<circle class="dot${scRight ? '' : ' bad'}" cx="${px}" cy="${py}" r="8"/>${tag}</svg>`;
  }
  $('#sc-time').addEventListener('input', renderScore);
  $('#sc-streak').addEventListener('input', renderScore);
  const setRight = (v) => { scRight = v; $('#sc-right').setAttribute('aria-pressed', String(v)); $('#sc-wrong').setAttribute('aria-pressed', String(!v)); renderScore(); };
  $('#sc-right').addEventListener('click', () => setRight(true));
  $('#sc-wrong').addEventListener('click', () => setRight(false));
  renderScore();

  // =====================================================================
  // Station 3: retries
  // =====================================================================
  showCode($('#rt-plain-code'), 'c-plain');
  showCode($('#rt-cond-code'), 'c-cond');
  const first = calculateScore({ correct: true, elapsedMs: 3200, timeLimitMs: LIMIT });
  const second = calculateScore({ correct: true, elapsedMs: 5700, timeLimitMs: LIMIT });
  const SEQ = [
    { both: ['info', 'Answer B arrives at 3.2 s'] },
    { plain: ['ok', 'Saved. Gate count 12 → 13'], cond: ['ok', 'Saved (seat was empty). Gate count 12 → 13'] },
    { both: ['warn', 'The ack is lost on the way back to the phone'] },
    { both: ['info', 'No ack after 2.5 s: the phone resends, arriving at 5.7 s'] },
    { plain: ['bad', 'Saved again: arrival time is now 5.7 s'], cond: ['ok', 'ConditionalCheckFailed: the 3.2 s answer is kept'] },
    { plain: ['bad', 'Counted again: gate count 13 → 14, but only 13 people answered'], cond: ['ok', 'Seat already counted: gate count stays 13'] },
  ];
  let rtTimers = [];
  function rtReset() {
    rtTimers.forEach(clearTimeout); rtTimers = [];
    ['#rt-plain', '#rt-cond'].forEach((s) => { $(s).innerHTML = '<li class="empty">Waiting for an answer…</li>'; });
    $('#rt-plain-v').innerHTML = ''; $('#rt-cond-v').innerHTML = '';
    $('#rt-run').disabled = false;
  }
  function addLog(sel, [cls, text]) {
    const ul = $(sel);
    ul.querySelector('.empty')?.remove();
    const li = document.createElement('li'); li.className = cls; li.textContent = text; ul.append(li);
  }
  function rtRun() {
    rtReset();
    $('#rt-run').disabled = true;
    const gap = reduce.matches ? 0 : 750;
    SEQ.forEach((s, i) => rtTimers.push(setTimeout(() => {
      if (s.both) { addLog('#rt-plain', s.both); addLog('#rt-cond', s.both); }
      if (s.plain) addLog('#rt-plain', s.plain);
      if (s.cond) addLog('#rt-cond', s.cond);
    }, i * gap)));
    rtTimers.push(setTimeout(() => {
      $('#rt-plain-v').innerHTML = `<span class="bad">Ada scores ${second}, not ${first}</span><span class="bad">Count is wrong</span>`;
      $('#rt-cond-v').innerHTML = `<span class="good">Ada scores ${first}</span><span class="good">Count is right</span>`;
      $('#rt-run').disabled = false;
    }, SEQ.length * gap));
  }
  $('#rt-run').addEventListener('click', rtRun);
  $('#rt-reset').addEventListener('click', rtReset);
  rtReset();

  // =====================================================================
  // Station 4: burst
  // =====================================================================
  const CAP = 1000;
  const cv = $('#bs-canvas');
  const ctx = cv.getContext('2d');
  const bs = { n: 250, split: true, parts: [], t0: 0, raf: 0, animating: false };
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const keysFor = () => bs.split
    ? [{ key: 'QB7K2M#A#3', what: 'the answers', w: bs.n }, { key: 'QB7K2M#Q', what: "the question's gate", w: bs.n }]
    : [{ key: 'QB7K2M', what: 'everything in the game', w: 2 * bs.n }];
  function renderMeters() {
    $('#bs-n-out').textContent = String(bs.n);
    $('#bs-meters').innerHTML = keysFor().map((k) => {
      const ok = Math.min(k.w, CAP), over = Math.max(0, k.w - CAP);
      const pct = Math.round((k.w / CAP) * 100);
      const read = over
        ? `<b>${fmt(k.w)} writes/s</b> on ${k.what} · <span class="hot">${fmt(over)} throttled</span>`
        : `<b>${fmt(k.w)} writes/s</b> on ${k.what} · ${pct}% of the limit`;
      return `<div class="meter"><span class="key">${esc(k.key)}</span><div class="track" role="img" aria-label="${fmt(k.w)} writes a second against a limit of 1,000"><span class="fill" style="width:${(ok / (2 * CAP)) * 100}%"></span><span class="over" style="width:${(over / (2 * CAP)) * 100}%"></span><span class="limit"></span></div><span class="read">${read}</span></div>`;
    }).join('');
  }
  function sizeCanvas() {
    // grow the canvas so a big room's dots never run into the buckets on a narrow screen
    const cols = Math.max(10, Math.floor((cv.clientWidth - 24) / 9));
    const need = Math.max(280, 22 + Math.ceil(bs.n / cols) * 9 + 60 + 92 + 32);
    if (Math.abs(cv.clientHeight - need) > 1) cv.style.height = `${need}px`;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = cv.clientWidth, h = cv.clientHeight;
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function layout() {
    const w = cv.clientWidth, h = cv.clientHeight;
    const n = bs.n;
    const cols = Math.max(10, Math.floor((w - 24) / 9));
    const rows = Math.ceil(n / cols);
    const gapX = (w - 24) / cols;
    const players = Array.from({ length: n }, (_, i) => ({ x: 12 + gapX * (i % cols) + gapX / 2, y: 22 + Math.floor(i / cols) * 9 }));
    const keys = keysFor();
    const bw = Math.min(260, (w - 48) / keys.length - 24);
    const bh = 92;
    const by = h - bh - 18;
    const buckets = keys.map((k, j) => {
      const cx = w / (keys.length + 1) * (j + 1);
      return { ...k, x: cx - bw / 2, y: by, w: bw, h: bh, cx };
    });
    return { w, h, players, buckets, rows };
  }
  function drawScene(L, fills) {
    const ink = css('--ink'), muted = css('--muted'), hair = css('--hair'), good = css('--good'), bad = css('--bad'), card = css('--card'), accent = css('--accent');
    ctx.clearRect(0, 0, L.w, L.h);
    ctx.font = '600 11px "JetBrains Mono", monospace';
    ctx.fillStyle = muted; ctx.textAlign = 'left';
    ctx.fillText(`${bs.n} players`, 12, 12);
    ctx.fillStyle = accent;
    L.players.forEach((p) => { ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, Math.PI * 2); ctx.fill(); });
    L.buckets.forEach((b, j) => {
      const fill = fills ? fills[j] : 0;
      ctx.fillStyle = card; ctx.strokeStyle = ink; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.rect(b.x, b.y, b.w, b.h); ctx.fill(); ctx.stroke();
      const lvl = Math.min(1, fill / CAP);
      ctx.fillStyle = good; ctx.globalAlpha = 0.85;
      ctx.fillRect(b.x + 2, b.y + b.h - 2 - (b.h - 4) * lvl, b.w - 4, (b.h - 4) * lvl);
      ctx.globalAlpha = 1;
      if (fill > CAP) { ctx.fillStyle = bad; ctx.fillRect(b.x + 2, b.y + 2, b.w - 4, 6); }
      ctx.strokeStyle = hair; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(b.x, b.y + 2); ctx.lineTo(b.x + b.w, b.y + 2); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = ink; ctx.textAlign = 'center';
      ctx.font = '700 12px "JetBrains Mono", monospace';
      ctx.fillText(b.key, b.cx, b.y + b.h + 14);
      ctx.font = '800 20px "Bricolage Grotesque", sans-serif';
      ctx.fillText(fmt(Math.min(fill, CAP)), b.cx, b.y + b.h / 2 + 2);
      ctx.font = '600 10.5px "JetBrains Mono", monospace';
      ctx.fillStyle = muted;
      ctx.fillText('of 1,000/s', b.cx, b.y + b.h / 2 + 19);
    });
  }
  function finalFills() { return keysFor().map((k) => k.w); }
  function drawRest() { sizeCanvas(); drawScene(layout(), finalFills()); }
  function burst() {
    cancelAnimationFrame(bs.raf);
    sizeCanvas();
    const L = layout();
    if (reduce.matches) { drawScene(L, finalFills()); return; }
    const parts = [];
    L.players.forEach((p) => {
      for (let wi = 0; wi < 2; wi++) {
        const bj = bs.split ? wi : 0;
        const b = L.buckets[bj];
        parts.push({ sx: p.x, sy: p.y, tx: b.x + 8 + Math.random() * (b.w - 16), ty: b.y + 10 + Math.random() * (b.h - 20), bj, delay: Math.random() * 900, dur: 520 + Math.random() * 180 });
      }
    });
    parts.sort((a, c) => (a.delay + a.dur) - (c.delay + c.dur));
    const seen = L.buckets.map(() => 0);
    parts.forEach((pt) => { pt.n = ++seen[pt.bj]; pt.throttled = pt.n > CAP; });
    const fills = L.buckets.map(() => 0);
    const t0 = performance.now();
    $('#bs-go').disabled = true;
    const bad = css('--bad'), ink = css('--ink');
    const frame = (now) => {
      const t = now - t0;
      fills.fill(0);
      parts.forEach((pt) => { if (t >= pt.delay + pt.dur && !pt.throttled) fills[pt.bj]++; });
      drawScene(L, fills);
      let live = false;
      parts.forEach((pt) => {
        const p = (t - pt.delay) / pt.dur;
        if (p < 0) { live = true; return; }
        if (!pt.throttled && p >= 1) return;
        let x, y;
        if (p < 1) {
          const e = 1 - Math.pow(1 - p, 3);
          x = pt.sx + (pt.tx - pt.sx) * e; y = pt.sy + (pt.ty - pt.sy) * e;
          ctx.fillStyle = pt.throttled && p > 0.85 ? bad : ink;
        } else {
          const q = (p - 1) * 1.6;
          if (q > 1) return;
          x = pt.tx + (pt.tx > L.w / 2 ? 1 : -1) * q * 40; y = pt.ty - Math.sin(q * Math.PI) * 50 - q * 30;
          ctx.fillStyle = bad;
        }
        live = true;
        ctx.beginPath(); ctx.arc(x, y, 2.4, 0, Math.PI * 2); ctx.fill();
      });
      if (live) bs.raf = requestAnimationFrame(frame);
      else { drawScene(L, finalFills()); $('#bs-go').disabled = false; }
    };
    bs.raf = requestAnimationFrame(frame);
  }
  $('#bs-n').addEventListener('input', (e) => { bs.n = Number(e.target.value); cancelAnimationFrame(bs.raf); $('#bs-go').disabled = false; renderMeters(); drawRest(); });
  const setSplit = (v) => { bs.split = v; $('#bs-split').setAttribute('aria-pressed', String(v)); $('#bs-single').setAttribute('aria-pressed', String(!v)); cancelAnimationFrame(bs.raf); $('#bs-go').disabled = false; renderMeters(); drawRest(); };
  $('#bs-single').addEventListener('click', () => setSplit(false));
  $('#bs-split').addEventListener('click', () => setSplit(true));
  $('#bs-go').addEventListener('click', burst);
  renderMeters();
  drawRest();
  if ('ResizeObserver' in window) new ResizeObserver(() => { if (!bs.raf || $('#bs-go').disabled === false) drawRest(); }).observe(cv);
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', drawRest);
  new MutationObserver(drawRest).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  document.fonts?.ready.then(drawRest);

  // =====================================================================
  // Station 5: quiz
  // =====================================================================
  const QZ = [
    { q: 'A Lambda function returns and its memory may vanish. Where does Quibble keep the game so the next request can find it?', o: ['In a global variable', 'In DynamoDB', 'In the browser', 'In API Gateway'], a: 1, why: 'Lambda is stateless, so every game, answer and score lives in DynamoDB.' },
    { q: 'Who holds each player’s open WebSocket connection?', o: ['The ws-message function', 'DynamoDB', 'API Gateway', 'Amazon S3'], a: 2, why: 'API Gateway holds the socket. Lambdas reach players through PostToConnection with the connectionId.' },
    { q: 'Lambda can’t run setTimeout between requests. How does a question end on time?', o: ['The browser tells the server', 'A game-timer Lambda, invoked async with the deadline', 'A cron job every second', 'An EC2 instance'], a: 1, why: 'Whoever opens a question invokes game-timer with InvocationType Event and the deadline in the payload.' },
    { q: 'A phone resends the same answer because the ack got lost. What stops it counting twice?', o: ['Rate limiting', 'Deleting the first answer', 'A conditional write: attribute_not_exists', 'Nothing, it counts twice'], a: 2, why: 'The answer is saved only if that seat has no answer yet, and the gate only counts a seat once.' },
    { q: 'Which setting makes DynamoDB delete old games for free?', o: ['TTL on expiresAt', 'Point-in-time recovery', 'On-demand billing', 'A global secondary index'], a: 0, why: 'Items whose expiresAt has passed are deleted by DynamoDB itself, at no cost.' },
    { q: 'How many Lambda functions can a brand-new AWS account run at the same moment?', o: ['10', '100', '1,000', 'Unlimited'], a: 0, why: 'New accounts start at 10. Quibble’s quota:lambda script asks for the standard 1,000, for free.' },
    { q: 'Why does the api function get 1,769 MB of memory?', o: ['To cache the question bank', 'HTTP APIs require it', 'To store login sessions', 'It’s one full vCPU, and bcrypt is CPU-heavy'], a: 3, why: 'Lambda gives CPU in proportion to memory. 1,769 MB is exactly one vCPU, so a classroom can sign up at once.' },
    { q: 'Answer speed is measured from which moment?', o: ['The phone’s clock', 'When API Gateway received the message', 'When Lambda starts', 'When DynamoDB saves it'], a: 1, why: 'requestTimeEpoch is set by API Gateway, so a slow Lambda start never costs a player points.' },
  ];
  const SHAPES = [
    '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2 19 18H1z"/></svg>',
    '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 1 19 10 10 19 1 10z"/></svg>',
    '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8.5"/></svg>',
    '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="2" y="2" width="16" height="16"/></svg>',
  ];
  const QLIM = 20000;
  const qz = { i: 0, score: 0, streak: 0, res: [], raf: 0, t0: 0, phase: 'intro' };
  const stage = $('#qz-stage');
  const bar = $('#qz-bar');
  const best = () => { try { return Number(localStorage.getItem('quibble-tour-best')) || 0; } catch { return 0; } };
  const saveBest = (v) => { try { if (v > best()) localStorage.setItem('quibble-tour-best', String(v)); } catch { /* storage blocked */ } };
  const setTop = (left) => { $('#qz-progress').textContent = left; $('#qz-score').textContent = `${fmt(qz.score)} pts`; };

  function qzIntro() {
    cancelAnimationFrame(qz.raf);
    Object.assign(qz, { i: 0, score: 0, streak: 0, res: [], phase: 'intro' });
    bar.style.width = '100%';
    setTop('8 questions');
    const b = best();
    stage.innerHTML = `<div class="qz-intro"><h3 class="qz-q">Think you followed all that?</h3><ul><li>20 seconds a question. The bar at the top is your clock.</li><li>Right and instant: 1,000 points. Right at the buzzer: 500.</li><li>Three right in a row starts a streak bonus.</li></ul>${b ? `<p class="note">Your best on this device: ${fmt(b)} pts</p>` : ''}<div><button class="btn primary" type="button" id="qz-start">Start the round</button></div></div>`;
    $('#qz-start').addEventListener('click', qzAsk);
  }
  function qzAsk() {
    const Q = QZ[qz.i];
    qz.phase = 'q';
    setTop(`Question ${qz.i + 1} of ${QZ.length}`);
    stage.innerHTML = `<h3 class="qz-q">${esc(Q.q)}</h3><div class="opts">${Q.o.map((o, j) => `<button type="button" class="opt o${j}" data-j="${j}"><span class="shape">${SHAPES[j]}</span><span>${esc(o)}</span></button>`).join('')}</div>`;
    $$('.opt', stage).forEach((b) => b.addEventListener('click', () => qzReveal(Number(b.dataset.j))));
    $('.opt', stage).focus({ preventScroll: true });
    qz.t0 = performance.now();
    const tick = (now) => {
      const left = Math.max(0, 1 - (now - qz.t0) / QLIM);
      bar.style.width = `${left * 100}%`;
      if (qz.phase !== 'q') return;
      if (left <= 0) return qzReveal(-1);
      qz.raf = requestAnimationFrame(tick);
    };
    qz.raf = requestAnimationFrame(tick);
  }
  function qzReveal(j) {
    if (qz.phase !== 'q') return;
    qz.phase = 'reveal';
    cancelAnimationFrame(qz.raf);
    const Q = QZ[qz.i];
    const elapsed = Math.min(QLIM, performance.now() - qz.t0);
    const right = j === Q.a;
    qz.streak = right ? qz.streak + 1 : 0;
    const base = calculateScore({ correct: right, elapsedMs: elapsed, timeLimitMs: QLIM });
    const bonus = right ? streakBonus(qz.streak) : 0;
    qz.score += base + bonus;
    qz.res.push({ q: Q.q, right, pts: base + bonus });
    setTop(`Question ${qz.i + 1} of ${QZ.length}`);
    $$('.opt', stage).forEach((b) => {
      const k = Number(b.dataset.j);
      b.disabled = true;
      if (k === Q.a) b.classList.add('right');
      else if (k === j) b.classList.add('wrong');
      else b.classList.add('dim');
    });
    const head = j === -1 ? 'Time’s up' : right ? `Right, +${fmt(base)}${bonus ? ` and a +${bonus} streak bonus` : ''}` : 'Not quite';
    const last = qz.i === QZ.length - 1;
    const fb = document.createElement('div');
    fb.className = `feedback ${right ? 'good' : 'bad'}`;
    fb.innerHTML = `<b>${head}</b><span>${esc(Q.why)}</span><div style="padding-top:6px"><button class="btn primary" type="button" id="qz-next">${last ? 'See your score' : 'Next question'}</button></div>`;
    stage.append(fb);
    $('#qz-next').addEventListener('click', () => { if (last) qzEnd(); else { qz.i++; qzAsk(); } });
    $('#qz-next').focus({ preventScroll: true });
  }
  function qzEnd() {
    qz.phase = 'end';
    const prevBest = best();
    saveBest(qz.score);
    const rightN = qz.res.filter((r) => r.right).length;
    setTop('Final score');
    bar.style.width = '0%';
    const note = qz.score > prevBest && prevBest ? 'A new best on this device.' : rightN === QZ.length ? 'All eight right. You could explain Quibble to the club.' : rightN >= 5 ? 'Solid. Station 1 has the answers to the ones you missed.' : 'Go back to Station 1 and step through the scenarios, then try again.';
    stage.innerHTML = `<div style="display:grid; gap:6px"><span class="kicker">${rightN} of ${QZ.length} right</span><span class="final">${fmt(qz.score)} pts</span><p class="note">${esc(note)}</p></div><ul class="review">${qz.res.map((r) => `<li><span class="mk ${r.right ? 'y' : 'n'}">${r.right ? 'Yes' : 'No'}</span><span>${esc(r.q)}</span><span class="p">+${fmt(r.pts)}</span></li>`).join('')}</ul><div><button class="btn primary" type="button" id="qz-again">Play again</button></div>`;
    $('#qz-again').addEventListener('click', () => { qzIntro(); $('#qz-start').focus({ preventScroll: true }); });
  }
  qzIntro();

  // =====================================================================
  // Copy buttons
  // =====================================================================
  $$('[data-copy]').forEach((btn) => btn.addEventListener('click', () => {
    const el = document.getElementById(btn.dataset.copy);
    const text = el.textContent;
    const done = (ok) => { btn.textContent = ok ? 'Copied' : 'Selected'; setTimeout(() => { btn.textContent = 'Copy'; }, 1600); };
    const select = () => { const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); done(false); };
    try { navigator.clipboard.writeText(text).then(() => done(true), select); } catch { select(); }
  }));
})();
