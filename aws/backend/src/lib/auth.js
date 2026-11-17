// Stateless JWT auth. The browser keeps the token and sends it as
//   Authorization: Bearer <token>        on REST calls (API Gateway HTTP API)
//   wss://...?token=<token>              when opening the WebSocket ($connect)
// (A cookie isn't an option: the S3 site and the two API Gateway APIs are different origins.)
import jwt from 'jsonwebtoken';
import { env } from './config.js';
import { getUserById, publicUser } from './users.js';
import { HttpError } from './errors.js';

export const signToken = (userId) => jwt.sign({ sub: userId }, env.jwtSecret, { expiresIn: '7d' });

/** Returns the user for a token, or null if the token is bad or the user is banned / deleted.
 *  Reads DynamoDB every time so a ban takes effect immediately. */
export async function userFromToken(token) {
  if (!token) return null;
  let payload;
  try {
    payload = jwt.verify(token, env.jwtSecret);
  } catch {
    return null;
  }
  const user = await getUserById(payload.sub);
  if (!user || user.banned) return null;
  return publicUser(user);
}

export async function requireAuth(event) {
  const header = event.headers?.authorization || event.headers?.Authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const user = await userFromToken(token);
  if (!user) throw new HttpError(401, 'Not logged in');
  return user;
}

export async function requireAdmin(event) {
  const user = await requireAuth(event);
  if (user.role !== 'admin') throw new HttpError(403, 'Admins only');
  return user;
}
