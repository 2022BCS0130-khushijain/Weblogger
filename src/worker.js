import { fileURLToPath } from 'node:url';
import { query, pool } from './db.js';
import { redis, createRedis } from './redis.js';
import { EVENT_QUEUE } from './events.js';
import { NOTIF_SELECT, NOTIF_FROM } from './modules/notifications.js';

/**
 * The background worker. It sits in a loop:
 *   BRPOP queue:events   (wait until an event appears)
 *   -> save a notification row in Postgres
 *   -> publish it on Redis channel notify:user:<id>  (the WebSocket server forwards it live)
 */
async function handle(ev) {
  const r = await query(
    `INSERT INTO notifications(user_id, actor_id, type, blog_id) VALUES ($1,$2,$3,$4) RETURNING id`,
    [ev.targetUserId, ev.actorId, ev.type, ev.blogId ?? null],
  );
  const row = (await query(`SELECT ${NOTIF_SELECT} ${NOTIF_FROM} WHERE n.id=$1`, [r.rows[0].id])).rows[0];
  await redis.publish(`notify:user:${ev.targetUserId}`, JSON.stringify({ type: 'notification', notification: row }));
}

export function startWorker() {
  const conn = createRedis(); // BRPOP blocks its connection, so it needs its own
  let running = true;

  (async () => {
    console.log('✔ worker started (listening on Redis list "queue:events")');
    while (running) {
      try {
        const item = await conn.brpop(EVENT_QUEUE, 2);
        if (!item) continue;
        await handle(JSON.parse(item[1]));
      } catch (e) {
        if (!running) break;
        console.error('worker error:', e.message);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  })();

  return () => { running = false; conn.disconnect(); };
}

// `npm run worker` runs this file on its own.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const stop = startWorker();
  process.on('SIGINT', () => { stop(); pool.end(); process.exit(0); });
}
