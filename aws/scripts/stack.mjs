// Shared helpers for the deploy / publish / seed scripts.
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const AWS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ROOT_DIR = path.resolve(AWS_DIR, '..');
export const STACK = process.env.QUIBBLE_STACK || 'quibble';

/** CloudFormation stack outputs as a plain object: { WebsiteUrl, HttpApiUrl, ... } */
export async function stackOutputs(stackName = STACK) {
  const cf = new CloudFormationClient({});
  let res;
  try {
    res = await cf.send(new DescribeStacksCommand({ StackName: stackName }));
  } catch (err) {
    throw new Error(`Could not read stack "${stackName}" (${err.message}). Did you run "npm run deploy"? Is your AWS region set?`);
  }
  return Object.fromEntries((res.Stacks[0].Outputs || []).map((o) => [o.OutputKey, o.OutputValue]));
}
