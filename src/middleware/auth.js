import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { HttpError } from '../utils.js';

export const signAccess = (userId) =>
  jwt.sign({ sub: String(userId) }, config.jwtSecret, { expiresIn: config.accessTtlSec });

/** Returns the user id inside a valid token, or null. */
export function verifyAccess(token) {
  try {
    return Number(jwt.verify(token, config.jwtSecret).sub);
  } catch {
    return null;
  }
}

/** Reads "Authorization: Bearer <token>" if present. Never blocks the request. */
export function optionalAuth(req, res, next) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) {
    const id = verifyAccess(h.slice(7));
    if (id) req.userId = id;
  }
  next();
}

/** Blocks the request with 401 unless the caller is logged in. */
export function requireAuth(req, res, next) {
  if (!req.userId) return next(new HttpError(401, 'Login required'));
  next();
}
