// This account's Lambda concurrency quota (Service Quotas code L-B99A9384) in the current region.
//   npm run quota:lambda                show it, the AWS default and any open increase request
//   npm run quota:lambda -- --request   ask AWS to raise it to 1000 (free; usually approved within a day)
// New accounts start at 10 concurrent executions, shared by every function: far too few for a 250-player game.
const SERVICE = 'lambda';
const QUOTA_CODE = 'L-B99A9384';
const TARGET = 1000;
const OPEN = new Set(['PENDING', 'CASE_OPENED']);

const request = process.argv.slice(2).includes('--request');

async function sdk(pkg) {
  try {
    return await import(pkg);
  } catch {
    console.error(`${pkg} is not installed. Run "npm install" in the project folder.`);
    process.exit(1);
  }
}

const sq = await sdk('@aws-sdk/client-service-quotas');
const lambda = await sdk('@aws-sdk/client-lambda');

const quotas = new sq.ServiceQuotasClient({});
const region = await quotas.config.region().catch(() => null);
if (!region) {
  console.error('No AWS region set. Run "aws configure" or set AWS_REGION (the quota is per region).');
  process.exit(1);
}
const ids = { ServiceCode: SERVICE, QuotaCode: QUOTA_CODE };

// What Lambda enforces right now. Service Quotas may not list an applied value for every account.
async function current() {
  const res = await new lambda.LambdaClient({ region }).send(new lambda.GetAccountSettingsCommand({}));
  return res.AccountLimit?.ConcurrentExecutions;
}

async function awsDefault() {
  try {
    return (await quotas.send(new sq.GetAWSDefaultServiceQuotaCommand(ids))).Quota?.Value;
  } catch {
    return undefined;
  }
}

async function openRequests() {
  const res = await quotas.send(new sq.ListRequestedServiceQuotaChangeHistoryByQuotaCommand(ids));
  return (res.RequestedQuotas || []).filter((r) => OPEN.has(r.Status));
}

const describe = (r) =>
  `${r.Status} request for ${r.DesiredValue} (made ${r.Created ? new Date(r.Created).toISOString().slice(0, 10) : '?'}${r.CaseId ? `, support case ${r.CaseId}` : ''})`;

try {
  const [value, std, pending] = await Promise.all([current(), awsDefault(), openRequests()]);
  console.log(`Lambda concurrent executions in ${region}: ${value ?? 'unknown'} (AWS standard: ${std ?? TARGET})`);
  for (const r of pending) console.log(`  open: ${describe(r)}`);

  if (!request) {
    if (value !== undefined && value < TARGET && !pending.length) {
      console.log('\nRequest the standard 1000 with:  npm run quota:lambda -- --request');
    }
  } else if (value !== undefined && value >= TARGET) {
    console.log(`\nAlready ${value}; nothing to request.`);
  } else if (pending.length) {
    console.log('\nAn increase request is already open; AWS will email the account owner when it is decided.');
  } else {
    const res = await quotas.send(new sq.RequestServiceQuotaIncreaseCommand({ ...ids, DesiredValue: TARGET }));
    console.log(`\nRequested ${TARGET}: ${describe(res.RequestedQuota || {})}`);
    console.log('AWS usually decides within a day. Check progress with:  npm run quota:lambda');
  }
} catch (err) {
  if (err.name === 'ResourceAlreadyExistsException') {
    console.log('\nAn increase request is already open for this quota.');
  } else if (err.name === 'AccessDeniedException') {
    console.error(`\nNot allowed: ${err.message}\nUse an IAM identity with servicequotas:* and lambda:GetAccountSettings, or ask in the console:`);
    console.error(`  https://${region}.console.aws.amazon.com/servicequotas/home/services/lambda/quotas/${QUOTA_CODE}`);
    process.exit(1);
  } else {
    console.error(`\nFailed: ${err.name}: ${err.message}`);
    process.exit(1);
  }
}
