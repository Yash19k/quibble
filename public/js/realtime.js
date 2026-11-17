// Tiny WebSocket client for the API Gateway WebSocket API.
//   send(event, data) -> Promise<{ ok, error?, ... }>   (the server acks every message)
//   on(event, fn)      server pushes: room:state, question:show, ... plus local 'open' / 'close'
// Reconnects automatically with backoff; the app re-sends 'hello' on every open so the server
// can put the user back into their game.
export class Realtime {
  constructor(url, getToken) {
    this.url = url;
    this.getToken = getToken;
    this.handlers = new Map();
    this.pending = new Map();
    this.queue = [];
    this.seq = 0;
    this.retry = 0;
    this.stopped = false;
    this.connect();
  }

  connect() {
    if (this.stopped) return;
    const ws = new WebSocket(`${this.url}?token=${encodeURIComponent(this.getToken() || '')}`);
    this.ws = ws;
    let opened = false;

    ws.onopen = () => {
      opened = true;
      this.retry = 0;
      for (const m of this.queue.splice(0)) ws.send(m);
      // API Gateway drops sockets idle for 10 minutes; keep the lobby alive.
      this.keepalive = setInterval(() => this.send('ping'), 5 * 60 * 1000);
      this.fire('open');
    };

    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === 'ack') {
        const done = this.pending.get(msg.id);
        if (done) { this.pending.delete(msg.id); const { type, id, ...rest } = msg; done(rest); }
      } else if (msg.type === 'event') {
        this.fire(msg.event, msg.data);
      }
    };

    ws.onclose = () => {
      clearInterval(this.keepalive);
      for (const done of this.pending.values()) done({ ok: false, error: 'Connection lost. Try again.' });
      this.pending.clear();
      this.fire('close', { wasOpen: opened });
      if (this.stopped) return;
      const delay = Math.min(1000 * 2 ** this.retry++, 15000);
      setTimeout(() => this.connect(), delay);
    };
  }

  on(event, fn) {
    if (!this.handlers.has(event)) this.handlers.set(event, []);
    this.handlers.get(event).push(fn);
  }

  fire(event, data) {
    for (const fn of this.handlers.get(event) || []) fn(data);
  }

  send(event, data = {}) {
    return new Promise((resolve) => {
      const id = ++this.seq;
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) resolve({ ok: false, error: 'The server did not respond. Try again.' });
      }, 15000);
      this.pending.set(id, (r) => { clearTimeout(timer); resolve(r); });
      const msg = JSON.stringify({ action: 'message', id, event, data });
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(msg);
      else this.queue.push(msg);
    });
  }

  close() {
    this.stopped = true;
    this.ws?.close();
  }
}
