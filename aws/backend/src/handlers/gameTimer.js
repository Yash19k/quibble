// GameTimer: invoked asynchronously (fire-and-forget) with one of
//   {kind:'question', code, qIndex, dueAt}  pushes answer counts, then closes the question at its deadline
//   {kind:'reveal',   code, qIndex, dueAt}  opens the next question (or ends the game) after the reveal pause
//   {kind:'lobby',    code, due, dueAt}     pushes the batched lobby list
//   {kind:'unstick',  code}                 moves an overdue game on (its timer was lost)
// Every kind is idempotent, so Lambda's automatic retries, duplicates and late deliveries are harmless.
// These invocations chain (reveal -> question -> reveal ...), so the function sets RecursiveLoop: Allow in the template.
import { runTimer } from '../lib/game.js';
import { log } from '../lib/log.js';

export const handler = async (event) => {
  try {
    await runTimer(event);
  } catch (err) {
    log('error', 'timer failed', { error: err, ...event });
    throw err; // let Lambda retry
  }
};
