// Lambdas can't keep a setTimeout running between requests, so question deadlines are driven by
// the GameTimer Lambda: we invoke it asynchronously with { code, qIndex, phase, dueAt }; it
// sleeps until dueAt and then advances the game (if nobody else already did).
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { env } from './config.js';

let client;
const lambda = () => (client ??= new LambdaClient({}));

export async function scheduleAdvance({ code, qIndex, phase, dueAt }) {
  const payload = { code, qIndex, phase, dueAt };
  const local = globalThis.__QUIBBLE_LOCAL__;
  if (local) return local.schedule(payload);
  await lambda().send(new InvokeCommand({
    FunctionName: env.timerFunction,
    InvocationType: 'Event', // fire-and-forget; Lambda retries automatically on failure
    Payload: Buffer.from(JSON.stringify(payload)),
  }));
}
