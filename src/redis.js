import Redis from 'ioredis';
import { config } from './config.js';

export const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 2 });
redis.on('error', (e) => console.error('redis error', e.message));

/** A separate connection (needed for subscribing and for blocking commands like BRPOP). */
export function createRedis() {
  const r = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
  r.on('error', (e) => console.error('redis(sub) error', e.message));
  return r;
}
