// WebSocket client for the API Gateway WebSocket API. It runs in browsers and in Node 22 (global WebSocket),
// so the load test drives exactly the code players run. Nothing touches the DOM at module load.
//
//   const rt = new Realtime(url, getToken, opts)
//   rt.send(event, data) -> Promise<{ ok, error?, ...ack fields }>   (never rejects)
//   rt.on(event, fn)     -> unsubscribe function. Server pushes (room:state, question:show, ...) and local events:
//                           'open', 'close' {wasOpen, code, failedOpens}, 'status' (new status), 'busy' (boolean)
//   rt.status            -> 'connecting' | 'open' | 'reconnecting' | 'closed'
//   rt.reconnect(ms?)    drop the socket now; reconnect after `ms` (default: the usual backoff). Pending sends stay.
//   rt.close()           stop for good; pending sends resolve { ok: false }
//
// Delivery. Every message waits for its ack and is resent with the SAME id (all server actions are idempotent):
//   - 200-800 ms after an API Gateway error frame ({"message": "Internal server error", ...} when the Lambda was
//     throttled or failed). The frame doesn't say which message failed, so everything sent before it goes again.
//   - when no ack arrives: after 2.5 s, then doubling with jitter, capped at 8 s
//   - after a reconnect: messages are kept across socket drops
// A message fails after 30 s with "The server did not respond. Try again.".
//
// Connection. Reconnects with full-jitter backoff (capped at 5 s). Coming back online, showing the tab again or
// restoring the page resets the backoff; if the socket still looks open we ping it and replace it when nothing at
// all comes back within 3 s (a half-open socket after a network switch). The same happens when a message waits
// through two ack timeouts while the socket stays completely silent.
//
// opts (all optional): WebSocket (implementation), ackTimeoutMs, ackTimeoutCapMs, giveUpMs, errorResendMinMs,
// errorResendMaxMs, reconnectBaseMs, reconnectCapMs, connectTimeoutMs, probeTimeoutMs, deadSocketMs, keepaliveMs,
// log(message, detail) for debugging.

export const NO_RESPONSE = 'The server did not respond. Try again.';
export const CLOSED = 'Connection closed.';

const DEFAULTS = {
  ackTimeoutMs: 2500,
  ackTimeoutCapMs: 8000,
  giveUpMs: 30_000,
  errorResendMinMs: 200,
  errorResendMaxMs: 800,
  reconnectBaseMs: 1000,
  reconnectCapMs: 5000,
  connectTimeoutMs: 10_000, // a handshake that hangs this long (dead network) is abandoned
  probeTimeoutMs: 3000,
  deadSocketMs: 7000, // silence this long while a message waits for its ack -> the socket is presumed dead
  keepaliveMs: 5 * 60_000, // API Gateway closes sockets that are idle for 10 minutes
};

const CONNECTING = 0;
const OPEN = 1;

/** 8 random hex chars from crypto.getRandomValues (randomUUID / subtle don't exist on plain-HTTP pages). */
function randomTag() {
  const a = new Uint8Array(4);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(a);
  else for (let i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

export class Realtime {
  constructor(url, getToken, opts = {}) {
    const { WebSocket: Impl = globalThis.WebSocket, log, ...tuning } = opts;
    if (typeof Impl !== 'function') throw new Error('WebSocket is not available here: pass opts.WebSocket.');
    this.url = url;
    this.getToken = getToken;
    this.opts = { ...DEFAULTS, ...tuning };
    this.Impl = Impl;
    this.log = typeof log === 'function' ? log : () => {};
    this.handlers = new Map();
    this.pending = new Map(); // id -> { id, frame, sentAt, sends, ackTimer, giveUpTimer, resolve }
    this.seq = 0;
    // Message ids are "<random tag>-<n>": unique per client, so acks and server logs never mix up two clients.
    this.idPrefix = `${randomTag()}-`;
    this.ws = null;
    this.opened = false; // has the current socket opened?
    this.attempt = 0; // reconnects since the last successful open (drives the backoff)
    this.failedOpens = 0; // consecutive sockets that closed before opening (bad token? $connect throttled?)
    this.lastFrameAt = 0;
    this.busy = false;
    this.stopped = false;
    this.probeTimer = null;
    this.timers = { reconnect: null, connect: null, keepalive: null };
    this._status = 'connecting';
    this._hookPage();
    this.connect();
  }

  get status() {
    return this._status;
  }

  on(event, fn) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event).add(fn);
    return () => this.handlers.get(event)?.delete(fn);
  }

  send(event, data = {}) {
    return new Promise((resolve) => {
      if (this.stopped) return resolve({ ok: false, error: CLOSED });
      const id = this._nextId();
      const entry = {
        id,
        frame: JSON.stringify({ action: 'message', id, event, data }),
        sentAt: 0,
        sends: 0, // on the current socket
        ackTimer: null,
        giveUpTimer: null,
        resolve,
      };
      // At the deadline report the server's last "busy" answer if there was one, else "did not respond".
      entry.giveUpTimer = setTimeout(
        () => this._settle(id, entry.lastBusy ?? { ok: false, error: NO_RESPONSE, timedOut: true }),
        this.opts.giveUpMs
      );
      this.pending.set(id, entry);
      this._transmit(entry);
    });
  }

  /** Drop the current socket and reconnect after `afterMs` (default: the usual backoff). Pending sends are kept. */
  reconnect(afterMs) {
    if (this.stopped) return;
    if (this.ws) this._drop(this.ws, 4000, 'reconnect', afterMs);
    else if (afterMs != null) this._scheduleReconnect(afterMs);
  }

  close() {
    if (this.stopped) return;
    this.stopped = true;
    this._unhook?.();
    clearTimeout(this.timers.reconnect);
    clearTimeout(this.timers.connect);
    clearInterval(this.timers.keepalive);
    clearTimeout(this.probeTimer);
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = null;
      try { ws.close(1000, 'bye'); } catch { /* already closed */ }
    }
    for (const id of [...this.pending.keys()]) this._settle(id, { ok: false, error: CLOSED });
    this._setStatus('closed');
  }

  // ---------- connection ----------
  connect() {
    if (this.stopped) return;
    clearTimeout(this.timers.reconnect);
    this.timers.reconnect = null;
    if (this.ws) return; // already connecting or open
    let ws;
    try {
      const token = (typeof this.getToken === 'function' ? this.getToken() : '') || '';
      ws = new this.Impl(`${this.url}${this.url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`);
    } catch (err) {
      this.log('socket could not be created', err);
      this.opened = false;
      this._onSocketClose(0);
      return;
    }
    this.ws = ws;
    this.opened = false;
    clearTimeout(this.timers.connect);
    this.timers.connect = setTimeout(() => {
      if (ws === this.ws && ws.readyState === CONNECTING) this._drop(ws, 4001, 'connect timeout');
    }, this.opts.connectTimeoutMs);
    ws.onopen = () => { if (ws === this.ws) this._onOpen(); };
    ws.onmessage = (e) => { if (ws === this.ws) this._onFrame(e.data); };
    ws.onerror = () => {}; // a 'close' always follows
    ws.onclose = (e) => { if (ws === this.ws) this._onSocketClose(e?.code); };
  }

  _onOpen() {
    clearTimeout(this.timers.connect);
    this.opened = true;
    this.attempt = 0;
    this.failedOpens = 0;
    this.lastFrameAt = Date.now();
    this._setStatus('open');
    // Everything still waiting for an ack goes out again on the new socket.
    for (const entry of this.pending.values()) {
      entry.sends = 0;
      this._transmit(entry);
    }
    clearInterval(this.timers.keepalive);
    this.timers.keepalive = setInterval(() => this._ping(), this.opts.keepaliveMs);
    this.timers.keepalive?.unref?.(); // Node: an idle keepalive must not hold a finished script open
    this._fire('open');
  }

  _onSocketClose(code, reconnectInMs) {
    const wasOpen = this.opened;
    this.ws = null;
    this.opened = false;
    clearTimeout(this.timers.connect);
    clearInterval(this.timers.keepalive);
    clearTimeout(this.probeTimer);
    this.probeTimer = null;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.ackTimer); // resent after the next open
      entry.ackTimer = null;
    }
    if (!wasOpen) this.failedOpens += 1;
    this._updateBusy();
    this._fire('close', { wasOpen, code, failedOpens: this.failedOpens });
    if (this.stopped) return; // a 'close' handler may have called close()
    this._setStatus('reconnecting');
    this._scheduleReconnect(reconnectInMs);
  }

  /** Abandon a socket without waiting for its close handshake (which can hang on a dead network). */
  _drop(ws, code, reason, reconnectInMs) {
    ws.onopen = ws.onmessage = ws.onclose = null;
    try { ws.close(code, reason); } catch { /* already closing */ }
    if (ws === this.ws) this._onSocketClose(code, reconnectInMs);
  }

  _scheduleReconnect(delayMs) {
    if (this.stopped) return;
    clearTimeout(this.timers.reconnect);
    const { reconnectBaseMs: base, reconnectCapMs: cap } = this.opts;
    const wait = delayMs ?? Math.random() * Math.min(cap, base * 2 ** this.attempt); // full jitter
    this.attempt += 1;
    this.timers.reconnect = setTimeout(() => this.connect(), wait);
  }

  /** Back online / tab visible again / page restored: retry now, or check that an "open" socket still works. */
  _wake() {
    if (this.stopped) return;
    this.attempt = 0;
    if (this._isOpen()) return this._probe();
    if (this.ws && this.ws.readyState === CONNECTING) return; // the connect timeout covers a hung handshake
    this._scheduleReconnect(Math.random() * 250); // tiny jitter: 'online' fires for a whole room at once
  }

  _probe() {
    if (this.probeTimer) return;
    const ws = this.ws;
    const sentAt = Date.now();
    this._ping();
    this.probeTimer = setTimeout(() => {
      this.probeTimer = null;
      // Any frame at all (ack, push or even an error frame) proves the socket is alive.
      if (ws === this.ws && this._isOpen() && this.lastFrameAt < sentAt) {
        this.log('ping went unanswered, reconnecting');
        this.reconnect(0);
      }
    }, this.opts.probeTimeoutMs);
  }

  _ping() {
    if (!this._isOpen()) return;
    try { this.ws.send(JSON.stringify({ action: 'message', id: this._nextId(), event: 'ping', data: {} })); } catch { /* closing */ }
  }

  _nextId() {
    this.seq += 1;
    return `${this.idPrefix}${this.seq}`;
  }

  _hookPage() {
    const canListen = (t) => !!t && typeof t.addEventListener === 'function' && typeof t.removeEventListener === 'function';
    const win = typeof window !== 'undefined' && canListen(window) ? window : null;
    const doc = typeof document !== 'undefined' && canListen(document) ? document : null;
    const hooks = [];
    const wake = () => this._wake();
    if (win) hooks.push([win, 'online', wake], [win, 'pageshow', wake]);
    if (doc) hooks.push([doc, 'visibilitychange', () => { if (doc.visibilityState === 'visible') wake(); }]);
    for (const [target, type, fn] of hooks) target.addEventListener(type, fn);
    this._unhook = () => { for (const [target, type, fn] of hooks) target.removeEventListener(type, fn); };
  }

  _isOpen() {
    return !!this.ws && this.opened && this.ws.readyState === OPEN;
  }

  // ---------- messages ----------
  _transmit(entry) {
    clearTimeout(entry.ackTimer);
    entry.ackTimer = null;
    if (!this._isOpen()) return; // goes out when the socket (re)opens
    try { this.ws.send(entry.frame); } catch { return; } // closing: resent after the reconnect
    entry.sentAt = Date.now();
    entry.sends += 1;
    entry.ackTimer = setTimeout(() => this._noAck(entry.id), this._ackDelay(entry.sends));
    this._updateBusy();
  }

  _ackDelay(sends) {
    const { ackTimeoutMs: first, ackTimeoutCapMs: cap } = this.opts;
    if (sends <= 1) return first;
    return Math.min(cap, first * 2 ** (sends - 1) * (0.75 + Math.random() * 0.5));
  }

  _noAck(id) {
    const entry = this.pending.get(id);
    if (!entry || !this._isOpen()) return;
    if (entry.sends >= 2 && Date.now() - this.lastFrameAt >= this.opts.deadSocketMs) {
      // Not a single frame (ack, push or error) for a while: probably half-open. Start over on a fresh socket.
      this.log('socket silent, reconnecting');
      this.reconnect();
      return;
    }
    this._transmit(entry);
  }

  _onErrorFrame(frame) {
    const seenAt = Date.now();
    const { errorResendMinMs: lo, errorResendMaxMs: hi } = this.opts;
    this.log('error frame', frame);
    setTimeout(() => {
      if (this.stopped || !this._isOpen()) return; // a reconnect resends everything anyway
      for (const entry of this.pending.values()) {
        // Sent before the frame arrived and not resent since (by another frame's pass or its ack timer).
        if (entry.sends > 0 && entry.sentAt <= seenAt) this._transmit(entry);
      }
    }, lo + Math.random() * (hi - lo));
  }

  _onFrame(raw) {
    this.lastFrameAt = Date.now();
    let msg;
    try { msg = JSON.parse(typeof raw === 'string' ? raw : String(raw)); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'ack') {
      const { type, id, ...result } = msg;
      if (result.ok === false && result.retry === true && this._retryLater(id, result)) return;
      this._settle(id, result);
    } else if (msg.type === 'event') {
      this._fire(msg.event, msg.data);
    } else if ('message' in msg) {
      this._onErrorFrame(msg); // API Gateway's own frames have a message and no type
    }
  }

  /**
   * The server hit a temporary problem (throttling, a timeout) and said `retry: true`. Every action is idempotent, so
   * send the same message again after a growing, jittered pause instead of failing it. False if nothing is pending.
   */
  _retryLater(id, result) {
    const entry = this.pending.get(id);
    if (!entry) return false;
    entry.lastBusy = result;
    clearTimeout(entry.ackTimer);
    const delay = Math.min(3000, 250 * 2 ** Math.max(0, entry.sends - 1)) * (0.5 + Math.random());
    entry.ackTimer = setTimeout(() => {
      if (this.pending.get(id) === entry) this._transmit(entry);
    }, delay);
    return true;
  }

  _settle(id, result) {
    const entry = this.pending.get(id);
    if (!entry) return; // the ack of a resent duplicate, or of a ping
    this.pending.delete(id);
    clearTimeout(entry.ackTimer);
    clearTimeout(entry.giveUpTimer);
    this._updateBusy();
    entry.resolve(result);
  }

  // ---------- local events ----------
  _updateBusy() {
    let busy = false;
    for (const entry of this.pending.values()) if (entry.sends >= 2) { busy = true; break; }
    if (busy === this.busy) return;
    this.busy = busy;
    this._fire('busy', busy);
  }

  _setStatus(status) {
    if (status === this._status) return;
    this._status = status;
    this._fire('status', status);
  }

  _fire(event, data) {
    for (const fn of [...(this.handlers.get(event) || [])]) {
      try { fn(data); } catch (err) { console.error(`Realtime "${event}" handler failed`, err); }
    }
  }
}
