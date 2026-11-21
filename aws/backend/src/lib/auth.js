// Stateless JWT auth. The browser keeps the token and sends it as
//   Authorization: Bearer <token>        on REST calls (API Gateway HTTP API)
//   wss://...?token=<token>              when opening the WebSocket ($connect)
// (A cookie isn't an option: the site and the two API Gateway APIs are different origins.)
import jwt from 'jsonwebtoken';
import { env } from './config.js';
import { getUserById, publicUser, tokenRevoked } from './users.js';
import { HttpError } from './errors.js';

// The algorithm is pinned on both sides so a token can never pick its own (e.g. "none" or an RS/HS confusion).
const ALGORITHM = 'HS256';

/** `sessionVersion`: the user's current one (users.js tokenRevoked), so an admin's "sign out everywhere" can end it. */
export const signToken = (userId, sessionVersion = 0) =>
  jwt.sign({ sub: userId, ...(sessionVersion ? { sv: sessionVersion } : {}) }, env.jwtSecret, { expiresIn: '7d', algorithm: ALGORITHM });

/** { userId, iat (seconds), sv (session version) } for a valid token, else null. Does not touch the database. */
export function verifyToken(token) {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, env.jwtSecret, { algorithms: [ALGORITHM] });
    const sv = Number.isInteger(payload?.sv) ? payload.sv : 0;
    return typeof payload?.sub === 'string' && payload.sub ? { userId: payload.sub, iat: payload.iat, sv } : null;
  } catch {
    return null;
  }
}

/** Returns the user for a token, or null if the token is bad, the user is banned / deleted, or an admin signed them out
 *  everywhere after the token was issued. Reads DynamoDB every time (strongly consistent: the user may have registered
 *  milliseconds ago) so a ban takes effect immediately. */
export async function userFromToken(token) {
  const claims = verifyToken(token);
  if (!claims) return null;
  const user = await getUserById(claims.userId, { consistent: true });
  if (!user || user.banned || tokenRevoked(user, claims.sv)) return null;
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
