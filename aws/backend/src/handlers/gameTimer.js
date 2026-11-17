// GameTimer: invoked asynchronously with { code, qIndex, phase, dueAt }.
// Waits until the deadline, then closes the question / opens the next one.
// advance() is idempotent, so Lambda's automatic retries and early closes are harmless.
//
// While waiting it re-checks the game every ~1.5s and exits as soon as the phase is over
// (e.g. everyone answered early). That keeps Lambda concurrency and cost low: without it, a
// fast game would leave several timers sleeping for nothing.
import { advance, phaseStillOpen } from '../lib/game.js';
import { sleep } from '../lib/db.js';
import { log } from '../lib/log.js';

const POLL_MS = 1500;
const MAX_WAIT_MS = 80_000; // function timeout is 90s; questions are at most 60s

export const handler = async (event) => {
  const deadline = Math.min(event.dueAt, Date.now() + MAX_WAIT_MS);
  while (Date.now() < deadline) {
    await sleep(Math.min(POLL_MS, deadline - Date.now()));
    if (Date.now() < deadline && !(await phaseStillOpen(event))) return; // someone else moved the game on
  }
  try {
    await advance(event);
  } catch (err) {
    log('error', 'advance failed', { error: err, ...event });
    throw err; // let Lambda retry
  }
};
