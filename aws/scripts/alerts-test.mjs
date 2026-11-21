// Send a test alert email through the deployed monitor, and show whether the alert address has confirmed.
// Usage: npm run alerts:test
// Set the address with: npm run deploy -- AlertEmail=you@example.com
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { stackOutputs, STACK } from './stack.mjs';

const out = await stackOutputs();
if (!out.MonitorFunctionName) {
  console.error(`Stack "${STACK}" has no monitor yet. Run "npm run deploy -- AlertEmail=you@example.com" first.`);
  process.exit(1);
}

const res = await new LambdaClient({}).send(new InvokeCommand({
  FunctionName: out.MonitorFunctionName,
  Payload: Buffer.from(JSON.stringify({ action: 'test' })),
}));
const payload = JSON.parse(Buffer.from(res.Payload ?? []).toString() || 'null');
if (res.FunctionError) {
  console.error(`The monitor failed: ${payload?.errorMessage ?? res.FunctionError}`);
  process.exit(1);
}

const subs = payload?.subscriptions ?? [];
if (!subs.length) {
  console.log('No address is subscribed, so the test email went nowhere.');
  console.log('Add one with: npm run deploy -- AlertEmail=you@example.com');
  process.exit(1);
}
console.log('Test alert sent. Subscribed addresses:');
for (const s of subs) {
  const state = s.confirmed ? 'confirmed: the test email is on its way' : 'NOT confirmed yet: open the "AWS Notification - Subscription Confirmation" email and click Confirm subscription';
  console.log(`  ${s.endpoint} (${s.protocol}): ${state}`);
}
