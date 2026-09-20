import { redis } from './redis.js';

export const EVENT_QUEUE = 'queue:events';

/**
 * Drop a "something happened" message on a Redis list. The worker picks it up later.
 * The API request does NOT wait for notifications to be created -> faster responses.
 * event = { type: 'like'|'comment'|'reply'|'follow', actorId, targetUserId, blogId? }
 */
export async function emit(event) {
  try {
    if (event.actorId === event.targetUserId) return; // don't notify people about their own actions
    await redis.lpush(EVENT_QUEUE, JSON.stringify(event));
  } catch (e) {
    console.error('emit failed', e.message); // a failed notification must never break the request
  }
}
