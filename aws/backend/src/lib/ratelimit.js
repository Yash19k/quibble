// Fixed-window counter in DynamoDB, used to slow down password guessing per IP.
// (API Gateway stage throttling protects the APIs as a whole; this is per-client.)
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from './db.js';
import { env } from './config.js';
import { HttpError } from './errors.js';

const WINDOW_MS = 15 * 60 * 1000;

export async function limitAuth(ip) {
  const window = Math.floor(Date.now() / WINDOW_MS);
  const res = await ddb.send(new UpdateCommand({
    TableName: env.rateLimitsTable,
    Key: { key: `auth#${ip}#${window}` },
    UpdateExpression: 'ADD hits :one SET expiresAt = :exp',
    ExpressionAttributeValues: { ':one': 1, ':exp': Math.floor(((window + 1) * WINDOW_MS) / 1000) + 60 },
    ReturnValues: 'UPDATED_NEW',
  }));
  if (res.Attributes.hits > env.authRateMax) throw new HttpError(429, 'Too many attempts, try again in a few minutes.');
}
