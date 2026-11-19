// Lambdas can't keep a setTimeout running between requests, so deadlines are driven by the GameTimer Lambda: we invoke
// it asynchronously with a GameTimer event and it sleeps until `dueAt` (see advance() in lib/game.js):
//   {kind:'question', code, qIndex, dueAt}   {kind:'reveal', code, qIndex, dueAt}
//   {kind:'lobby', code, due, dueAt}         {kind:'unstick', code, dueAt}
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { env } from './config.js';
import { httpAgents } from './db.js';
import { log } from './log.js';

let client;
const lambda = () => (client ??= new LambdaClient({ requestHandler: httpAgents, maxAttempts: 4 }));

export async function scheduleAdvance(payload) {
  const local = globalThis.__QUIBBLE_LOCAL__;
  if (local) {
    // Like Lambda's async invoke: hand the event over and don't wait for the timer to run.
    Promise.resolve(local.schedule(payload)).catch((error) => log('error', 'local timer failed', { error, payload }));
    return;
  }
  await lambda().send(new InvokeCommand({
    FunctionName: env.timerFunction,
    InvocationType: 'Event', // fire-and-forget; Lambda queues it and retries failures
    Payload: Buffer.from(JSON.stringify(payload)),
  }));
}
