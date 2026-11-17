// One-command deploy: sam build -> sam deploy -> upload the frontend to S3.
// Usage: npm run deploy            (uses your default AWS profile/region)
//        AWS_REGION=eu-west-1 npm run deploy
//
// The JWT signing secret is generated once and kept in aws/.jwt-secret (git-ignored) so that
// redeploys don't log everybody out. Set JWT_SECRET to override.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { AWS_DIR, STACK } from './stack.mjs';

function run(cmd, args) {
  console.log(`\n> ${cmd} ${args.map((a) => (a.startsWith('JwtSecret=') ? 'JwtSecret=****' : a)).join(' ')}`);
  const r = spawnSync(cmd, args, { cwd: AWS_DIR, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const secretFile = path.join(AWS_DIR, '.jwt-secret');
let secret = process.env.JWT_SECRET;
if (!secret) {
  if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, crypto.randomBytes(48).toString('hex'), { mode: 0o600 });
  secret = fs.readFileSync(secretFile, 'utf8').trim();
}

const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
run('sam', ['build']);
run('sam', [
  'deploy',
  '--stack-name', STACK,
  '--resolve-s3',
  '--capabilities', 'CAPABILITY_IAM',
  '--no-fail-on-empty-changeset',
  '--parameter-overrides', `JwtSecret=${secret}`,
  ...(region ? ['--region', region] : []),
]);

await import('./publish-frontend.mjs');
console.log('\nFirst deploy? Run "npm run seed" to create the admin account and sample questions.');
