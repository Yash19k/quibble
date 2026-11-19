// One-command deploy: preflight (warnings only) -> sam build -> sam deploy -> upload the frontend to S3.
// Usage: npm run deploy                          (uses your default AWS profile/region)
//        AWS_REGION=eu-west-1 npm run deploy
//        npm run deploy -- LateGraceMs=5000      (template parameters as Name=value; they stick for later deploys)
//
// The JWT signing secret is generated once and kept in aws/.jwt-secret (git-ignored) so that
// redeploys don't log everybody out. Set JWT_SECRET to override.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

// stack.mjs loads an AWS SDK client (a root devDependency): explain a missing one instead of crashing.
let AWS_DIR, STACK;
try {
  ({ AWS_DIR, STACK } = await import('./stack.mjs'));
} catch (err) {
  console.error(`Missing a dependency (${err.message}). Run "npm install" in the project folder.`);
  process.exit(1);
}

// Only plain Name=value pairs, so they are safe to pass through a shell.
const PARAM = /^[A-Za-z][A-Za-z0-9]*=[\w.:/@+-]*$/;
const extraParams = process.argv.slice(2);
for (const p of extraParams) {
  if (!PARAM.test(p)) {
    console.error(`Unexpected argument "${p}". Pass template parameters as Name=value, e.g. LateGraceMs=5000`);
    process.exit(1);
  }
}

function run(cmd, args) {
  console.log(`\n> ${cmd} ${args.map((a) => (a.startsWith('JwtSecret=') ? 'JwtSecret=****' : a)).join(' ')}`);
  // On Windows `sam` is a .cmd file, which only runs through a shell (the arguments are joined unquoted, as before).
  const r = process.platform === 'win32'
    ? spawnSync([cmd, ...args].join(' '), { cwd: AWS_DIR, stdio: 'inherit', shell: true })
    : spawnSync(cmd, args, { cwd: AWS_DIR, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

// Readiness report first (SAM version, credentials, Lambda quota, live games). It never stops the deploy.
spawnSync(process.execPath, [path.join(AWS_DIR, 'scripts', 'preflight.mjs'), '--warn-only'], { stdio: 'inherit' });

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
  '--parameter-overrides', `JwtSecret=${secret}`, ...extraParams,
  ...(region ? ['--region', region] : []),
]);

await import('./publish-frontend.mjs');
console.log('\nFirst deploy? Run "npm run seed" to create the admin account and sample questions.');
