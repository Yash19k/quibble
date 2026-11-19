// Is this AWS account ready for a big game? Run it before an event:  npm run preflight
//   - AWS SAM CLI installed (>= 1.123: older versions can't deploy the game timer's RecursiveLoop setting)
//   - AWS credentials work and a region is set
//   - Lambda concurrency quota >= 500 (new accounts get 10, which would throttle a 250-player game)
//   - no live games on the deployed stack (a warning only)
// Exits with code 1 when a check fails. Flags:
//   --allow-degraded   accept a low Lambda concurrency quota (games still work, but slower; see the README)
//   --warn-only        report problems but always exit 0 (npm run deploy runs it this way first)
import { spawnSync } from 'node:child_process';

const args = new Set(process.argv.slice(2));
const warnOnly = args.has('--warn-only');
const allowDegraded = warnOnly || args.has('--allow-degraded');

const MIN_SAM = [1, 123, 0];
const MIN_CONCURRENCY = 500;
const QUOTA_CODE = 'L-B99A9384'; // Lambda "Concurrent executions"

let problems = 0;
let warnings = 0;
const ok = (msg) => console.log(`  [ok]   ${msg}`);
const warn = (msg) => {
  warnings++;
  console.log(`  [warn] ${msg}`);
};
const fail = (msg) => {
  problems++;
  console.log(`  [FAIL] ${msg}`);
};
const hint = (msg) => console.log(`         ${msg}`);

// AWS SDK clients are root devDependencies; a missing one should explain itself, not crash.
async function sdk(pkg) {
  try {
    return await import(pkg);
  } catch {
    fail(`${pkg} is not installed. Run "npm install" in the project folder.`);
    return null;
  }
}

function samVersion() {
  // On Windows `sam` is a .cmd file, which only runs through a shell.
  const r = process.platform === 'win32'
    ? spawnSync('sam --version', { encoding: 'utf8', shell: true })
    : spawnSync('sam', ['--version'], { encoding: 'utf8' });
  if (r.error || r.status !== 0) return null;
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(`${r.stdout} ${r.stderr}`);
  return m ? m.slice(1).map(Number) : null;
}

const atLeast = (v, min) => {
  for (let i = 0; i < min.length; i++) if (v[i] !== min[i]) return v[i] > min[i];
  return true;
};

function checkSam() {
  const v = samVersion();
  if (!v) {
    fail('AWS SAM CLI not found (needed to deploy).');
    hint('Install it: https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html');
  } else if (!atLeast(v, MIN_SAM)) {
    fail(`AWS SAM CLI ${v.join('.')} is too old; ${MIN_SAM.join('.')} or newer is needed (game timer RecursiveLoop).`);
    hint('Upgrade it: https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/manage-sam-cli-versions.html');
  } else {
    ok(`AWS SAM CLI ${v.join('.')}`);
  }
}

/** Credentials + region. Returns the region, or null when the AWS checks can't continue. */
async function checkIdentity() {
  const mod = await sdk('@aws-sdk/client-sts');
  if (!mod) return null;
  const sts = new mod.STSClient({});
  const region = await sts.config.region().catch(() => null);
  if (!region) {
    fail('No AWS region set.');
    hint('Run "aws configure" (or set AWS_REGION, e.g. AWS_REGION=eu-west-1).');
    return null;
  }
  try {
    const me = await sts.send(new mod.GetCallerIdentityCommand({}));
    ok(`AWS credentials: account ${me.Account} (${me.Arn})`);
    ok(`Region: ${region}`);
    return region;
  } catch (err) {
    fail(`AWS credentials don't work: ${err.message}`);
    hint('Run "aws configure" (or "aws sso login" for an SSO profile).');
    return null;
  }
}

async function checkConcurrency(region) {
  const mod = await sdk('@aws-sdk/client-lambda');
  if (!mod) return;
  let limits;
  try {
    limits = (await new mod.LambdaClient({ region }).send(new mod.GetAccountSettingsCommand({}))).AccountLimit;
  } catch (err) {
    fail(`Could not read the Lambda account settings: ${err.message}`);
    return;
  }
  const quota = limits?.ConcurrentExecutions ?? 0;
  const unreserved = limits?.UnreservedConcurrentExecutions ?? quota;
  if (quota >= MIN_CONCURRENCY) {
    ok(`Lambda concurrency quota: ${quota} (${unreserved} unreserved)`);
    if (unreserved < MIN_CONCURRENCY) {
      warn(`Only ${unreserved} of it is unreserved: other functions in this account reserve the rest.`);
    }
    return;
  }
  const msg = `Lambda concurrency quota is ${quota}. A 250-player game needs ${MIN_CONCURRENCY} or more (the AWS standard is 1000).`;
  if (allowDegraded) warn(msg);
  else fail(msg);
  hint('Ask AWS for the standard 1000 (free; usually approved within a day):');
  hint('  npm run quota:lambda -- --request');
  hint(`  or: aws service-quotas request-service-quota-increase --service-code lambda --quota-code ${QUOTA_CODE} --desired-value 1000 --region ${region}`);
  hint('Until it is raised, players see slow phases and late answers may be refused. Soften that with:');
  hint('  npm run deploy -- LateGraceMs=5000');
  if (!allowDegraded) hint('To go ahead anyway: npm run preflight -- --allow-degraded');
}

const LIVE = ['lobby', 'question', 'reveal'];

/** Warn when games are running: a deploy changes code and settings under them. */
async function checkLiveGames(region) {
  let stack;
  try {
    stack = await import('./stack.mjs');
  } catch {
    warn('Could not load the stack helper (run "npm install"); skipped the live-game check.');
    return;
  }
  let out;
  try {
    out = await stack.stackOutputs();
  } catch (err) {
    if (/does not exist/i.test(err.message)) ok(`Stack "${stack.STACK}" is not deployed yet (nothing live to disturb).`);
    else warn(`Skipped the live-game check: ${err.message}`);
    return;
  }
  if (out.WebsiteUrl) ok(`Players open: ${out.WebsiteUrl}`);
  if (!out.GamesTableName) {
    warn('This stack predates the GamesTableName output; redeploy to enable the live-game check.');
    return;
  }
  const mod = await sdk('@aws-sdk/client-dynamodb');
  if (!mod) return;
  const ddb = new mod.DynamoDBClient({ region });
  const now = Date.now();
  const live = [];
  try {
    let ExclusiveStartKey;
    do {
      const res = await ddb.send(new mod.ScanCommand({
        TableName: out.GamesTableName,
        ProjectionExpression: '#c, #s, lobbyExpiresAt, playerCount',
        FilterExpression: '#s IN (:a, :b, :c)',
        ExpressionAttributeNames: { '#c': 'code', '#s': 'status' },
        ExpressionAttributeValues: { ':a': { S: LIVE[0] }, ':b': { S: LIVE[1] }, ':c': { S: LIVE[2] } },
        ExclusiveStartKey,
      }));
      for (const g of res.Items || []) {
        const expires = Number(g.lobbyExpiresAt?.N);
        if (g.status?.S === 'lobby' && expires && expires < now) continue; // abandoned lobby
        live.push(`${g.code?.S} (${g.status?.S}${g.playerCount?.N ? `, ${g.playerCount.N} players` : ''})`);
      }
      ExclusiveStartKey = res.LastEvaluatedKey;
    } while (ExclusiveStartKey);
  } catch (err) {
    warn(`Could not check for live games: ${err.message}`);
    return;
  }
  if (!live.length) ok('No live games.');
  else warn(`${live.length} live game(s): ${live.slice(0, 5).join(', ')}${live.length > 5 ? ', ...' : ''}. Deploying now can disturb them.`);
}

console.log('Quibble preflight');
checkSam();
const region = await checkIdentity();
if (region) {
  await checkConcurrency(region);
  await checkLiveGames(region);
}

if (problems && !warnOnly) {
  console.log(`\nPreflight failed: ${problems} problem(s) above.`);
  process.exit(1);
}
if (problems) console.log(`\nPreflight found ${problems} problem(s) (warn-only, continuing).`);
else console.log(warnings ? `\nPreflight passed with ${warnings} warning(s).` : '\nPreflight passed.');
