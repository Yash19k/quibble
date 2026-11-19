// REST client with retries. No DOM access: the browser app and the Node load test both import it.
//
//   request(baseUrl, path, { method, body, token, budgetMs, onRetry, fetchImpl })
//     2xx  -> the parsed JSON body (or null when there is none)
//     else -> throws an Error with .status (0 = no response), .body (parsed JSON or null),
//             .field (the body's `field`, e.g. 'email' on a sign-up 409; else null) and .retryable
//
// Retried with full-jitter backoff (Retry-After honoured) until the time budget runs out:
//   - network errors and timeouts (offline, DNS, or a gateway error without CORS headers)
//   - 429/500/502/504 sent by API Gateway itself ({"message": ...}: stage throttling, a throttled Lambda)
//   - any 503 (API Gateway's, or ours: {"error": "Server busy, please try again."})
// Never retried: app-level answers ({"error": ...} with a 4xx - including our own 429 rate limits, whose windows are
// minutes long - or our own 500). Repeating them can't help.

const BACKOFF_BASE_MS = 250;
const BACKOFF_CAP_MS = 4000;
const LONG_BUDGET_MS = 60_000; // GETs and /api/auth/*: safe to repeat and worth waiting for (sign-up storms)
const SHORT_BUDGET_MS = 15_000; // everything else
const MIN_ATTEMPT_MS = 1000; // don't start an attempt that would be cut off almost at once

export const BUSY_MESSAGE = 'Server busy, please try again.';
export const OFFLINE_MESSAGE = "Can't reach the server. Check your connection and try again.";
export const TIMEOUT_MESSAGE = 'The server is taking too long. Please try again.';

/** Default time budget for a call: long for reads and auth, short for other writes. */
export function budgetFor(method, path) {
  return method === 'GET' || String(path).startsWith('/api/auth/') ? LONG_BUDGET_MS : SHORT_BUDGET_MS;
}

/** Should this HTTP failure be retried? (`data` is the parsed body or null.) */
export function isRetryableStatus(status, data) {
  if (status === 503) return true; // API Gateway's, or ours (AWS throttling outlasted the SDK's retries)
  if (status !== 429 && status !== 500 && status !== 502 && status !== 504) return false;
  // Our Lambda always answers {"error": ...}. Anything else came from API Gateway or a proxy in between.
  return !(data && typeof data === 'object' && typeof data.error === 'string');
}

/** Retry-After as milliseconds: the header (needs CORS ExposeHeaders) or our body's `retryAfter` (seconds). */
export function retryAfterMs(headers, data, now = Date.now()) {
  const raw = headers?.get?.('retry-after');
  if (raw) {
    const secs = Number(raw);
    if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
    const at = Date.parse(raw);
    if (!Number.isNaN(at)) return Math.max(0, at - now);
  }
  const body = Number(data?.retryAfter);
  return Number.isFinite(body) && body >= 0 ? body * 1000 : null;
}

function messageFor(status, data, retryable) {
  if (typeof data?.error === 'string' && data.error) return data.error;
  if (retryable) return BUSY_MESSAGE; // the gateway's "Internal Server Error" / "Too Many Requests" mean "busy"
  if (typeof data?.message === 'string' && data.message) return data.message;
  return `Request failed (${status})`;
}

function makeError(message, { status = 0, body = null, retryable = false, cause } = {}) {
  const err = new Error(message);
  err.status = status;
  err.body = body;
  err.retryable = retryable;
  err.field = body && typeof body.field === 'string' ? body.field : null;
  if (cause) err.cause = cause;
  return err;
}

async function readJson(res) {
  let text = '';
  try { text = await res.text(); } catch { return null; }
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One attempt. Resolves to { ok, data } or { error, retryAfter } - never throws. */
async function attempt(fetchImpl, url, init, timeoutMs) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let timedOut = false;
  const timer = controller ? setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs) : null;
  try {
    const res = await fetchImpl(url, controller ? { ...init, signal: controller.signal } : init);
    const data = await readJson(res);
    if (res.ok) return { ok: true, data };
    const retryable = isRetryableStatus(res.status, data);
    return {
      error: makeError(messageFor(res.status, data, retryable), { status: res.status, body: data, retryable }),
      retryAfter: retryable ? retryAfterMs(res.headers, data) : null,
    };
  } catch (cause) {
    return { error: makeError(timedOut ? TIMEOUT_MESSAGE : OFFLINE_MESSAGE, { retryable: true, cause }), retryAfter: null };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Call the REST API. `budgetMs` caps the total time spent including retries (default: budgetFor()).
 * `onRetry({ attempt, delayMs, status, error })` runs before each wait, so the UI can say "still trying".
 * `random` is injectable for tests.
 */
export async function request(baseUrl, path, {
  method = 'GET', body, token, budgetMs, onRetry, fetchImpl = globalThis.fetch, random = Math.random,
} = {}) {
  const verb = String(method).toUpperCase();
  const budget = budgetMs ?? budgetFor(verb, path);
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const init = { method: verb, headers, body: body !== undefined ? JSON.stringify(body) : undefined };
  const url = `${baseUrl || ''}${path}`;
  const started = Date.now();

  for (let n = 0; ; n++) {
    const left = budget - (Date.now() - started);
    const out = await attempt(fetchImpl, url, init, Math.max(left, MIN_ATTEMPT_MS));
    if (out.ok) return out.data;
    const { error } = out;
    if (!error.retryable) throw error;

    const backoff = random() * Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** n);
    // Retry-After plus a little jitter, so a crowd that was throttled together doesn't come back together.
    const delayMs = out.retryAfter == null ? backoff : Math.max(backoff, out.retryAfter + random() * 500);
    const remaining = budget - (Date.now() - started) - delayMs;
    if (remaining < MIN_ATTEMPT_MS) throw error; // out of time (or Retry-After is longer than we can wait)
    try { onRetry?.({ attempt: n + 1, delayMs, status: error.status, error }); } catch { /* UI hook only */ }
    await sleep(delayMs);
  }
}
