import { redis } from '../redis.js';
import { HttpError } from '../utils.js';

/**
 * Fixed-window counter in Redis:
 *   INCR key  -> on the first hit, EXPIRE key windowSec
 * Returns { allowed, retryAfter }. If Redis is down we "fail open" (allow) so the site keeps working.
 */
export async function hit(key, limit, windowSec) {
  try {
    const n = await redis.incr(key);
    if (n === 1) await redis.expire(key, windowSec);
    if (n > limit) return { allowed: false, retryAfter: Math.max(await redis.ttl(key), 1) };
  } catch (e) {
    console.error('rate limit error', e.message);
  }
  return { allowed: true, retryAfter: 0 };
}

/** Express middleware. `by: 'user'` counts per logged-in user (falls back to IP). */
export function rateLimit({ name, limit, windowSec, by = 'ip' }) {
  return async (req, res, next) => {
    const who = by === 'user' ? req.userId || req.ip : req.ip;
    const r = await hit(`rl:${name}:${who}`, limit, windowSec);
    if (!r.allowed) {
      res.set('Retry-After', String(r.retryAfter));
      return next(new HttpError(429, `Too many requests. Try again in ${r.retryAfter}s.`));
    }
    next();
  };
}
