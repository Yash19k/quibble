// Create the admin account and load the sample questions into the deployed DynamoDB tables.
// Usage: npm run seed      (admin credentials from .env: ADMIN_EMAIL / ADMIN_USERNAME / ADMIN_PASSWORD)
import 'dotenv/config';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { QUESTIONS } from './questions.js';

// AWS SDK clients (stack.mjs: root devDependencies; lib/*: aws/backend) - explain a missing one instead of crashing.
async function load(spec) {
  try {
    return await import(spec);
  } catch (err) {
    console.error(`Missing a dependency (${err.message}). Run "npm install" in the project folder.`);
    process.exit(1);
  }
}

const { stackOutputs } = await load('./stack.mjs');
const out = await stackOutputs();
process.env.USERS_TABLE = out.UsersTableName;
process.env.QUESTIONS_TABLE = out.QuestionsTableName;

const { upsertAdmin } = await load('../backend/src/lib/users.js');
const { insertMany } = await load('../backend/src/lib/questions.js');

const email = process.env.ADMIN_EMAIL || 'admin@example.com';
const username = process.env.ADMIN_USERNAME || 'admin';
let password = process.env.ADMIN_PASSWORD;
let generated = false;
// This site is public on the internet: never seed a well-known password.
if (!password || ['change-this-password', 'admin12345'].includes(password) || password.length < 10) {
  password = crypto.randomBytes(12).toString('base64url');
  generated = true;
}

const { user, created } = await upsertAdmin({ email, username, passwordHash: await bcrypt.hash(password, 10) });
if (created) {
  console.log(`Created admin: ${email}`);
  if (generated) console.log(`  password: ${password}   <- generated; save it now (set ADMIN_PASSWORD in .env to choose your own)`);
} else {
  console.log(`Admin ${email} already exists (made sure it has the admin role; password unchanged).`);
}

const added = await insertMany(
  QUESTIONS.map(([text, options, correctIndex, category, timeLimit]) => ({ text, options, correctIndex, category, timeLimit })),
  user.id
);
console.log(`Added ${added} new questions (${QUESTIONS.length - added} already existed).`);
