import { WebSocketServer } from 'ws';
import { query } from '../db.js';
import { redis, createRedis } from '../redis.js';
import { hit } from '../middleware/rateLimit.js';
import { verifyAccess } from '../middleware/auth.js';
import { findBlog, canRead } from './blogs.js';

/**
 * Two WebSocket endpoints share one server:
 *   /ws/chat/blog/:blogId?token=JWT   -> live discussion under a blog
 *   /ws/notifications?token=JWT       -> live notification pushes
 *
 * How messages travel (works even with many server copies):
 *   user A -> this server -> save in Postgres -> PUBLISH to Redis channel "chat:blog:<id>"
 *   Redis -> EVERY server (each subscribed) -> sends to its own connected sockets in that room
 */
export function attachRealtime(httpServer) {
  const wss = new WebSocketServer({ noServer: true });
  const chatRooms = new Map(); // blogId -> Set<socket>
  const userSockets = new Map(); // userId -> Set<socket>

  const add = (map, key, ws) => { if (!map.has(key)) map.set(key, new Set()); map.get(key).add(ws); };
  const remove = (map, key, ws) => { map.get(key)?.delete(ws); if (!map.get(key)?.size) map.delete(key); };
  const send = (ws, obj) => ws.readyState === 1 && ws.send(JSON.stringify(obj));

  // One subscriber connection listens to everything we care about.
  const sub = createRedis();
  sub.psubscribe('chat:blog:*', 'notify:user:*');
  sub.on('pmessage', (pattern, channel, message) => {
    const id = Number(channel.split(':')[2]);
    const targets = channel.startsWith('chat:blog:') ? chatRooms.get(id) : userSockets.get(id);
    targets?.forEach((ws) => ws.readyState === 1 && ws.send(message));
  });

  httpServer.on('upgrade', async (req, socket, head) => {
    const reject = (code, text) => { socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`); socket.destroy(); };
    try {
      const url = new URL(req.url, 'http://x');
      const userId = verifyAccess(url.searchParams.get('token') || '');
      const chat = url.pathname.match(/^\/ws\/chat\/blog\/(\d+)$/);

      if (url.pathname === '/ws/notifications') {
        if (!userId) return reject(401, 'Unauthorized');
        wss.handleUpgrade(req, socket, head, (ws) => onNotifications(ws, userId));
      } else if (chat) {
        if (!userId) return reject(401, 'Unauthorized');
        const blog = await findBlog('id', Number(chat[1]));
        if (!blog) return reject(404, 'Not Found');
        if (!canRead(blog, userId)) return reject(403, 'Forbidden'); // same permission rule as reading the blog
        wss.handleUpgrade(req, socket, head, (ws) => onChat(ws, userId, blog.id));
      } else {
        reject(404, 'Not Found');
      }
    } catch (e) {
      console.error('upgrade error', e.message);
      reject(500, 'Server Error');
    }
  });

  function heartbeat(ws) {
    ws.alive = true;
    ws.on('pong', () => (ws.alive = true));
  }

  function onNotifications(ws, userId) {
    heartbeat(ws);
    add(userSockets, userId, ws);
    ws.on('close', () => remove(userSockets, userId, ws));
  }

  async function onChat(ws, userId, blogId) {
    heartbeat(ws);
    add(chatRooms, blogId, ws);
    ws.on('close', () => remove(chatRooms, blogId, ws));

    // Send the last 50 messages so a new visitor sees the conversation.
    const history = (await query(
      `SELECT m.id, m.message, m.created_at, u.id AS user_id, u.username, u.display_name
       FROM chat_messages m JOIN users u ON u.id=m.user_id WHERE m.blog_id=$1 ORDER BY m.id DESC LIMIT 50`,
      [blogId],
    )).rows.reverse();
    send(ws, { type: 'history', messages: history });

    ws.on('message', async (raw) => {
      try {
        const data = JSON.parse(raw.toString());
        const text = String(data.message ?? '').trim().slice(0, 500);
        if (!text) return;

        // Max 5 messages per 5 seconds per user (uses the same Redis rate limiter as the REST API)
        const rl = await hit(`rl:chat:${userId}`, 5, 5);
        if (!rl.allowed) return send(ws, { type: 'error', error: 'You are sending messages too fast' });

        const saved = (await query(
          `WITH ins AS (INSERT INTO chat_messages(blog_id, user_id, message) VALUES ($1,$2,$3) RETURNING *)
           SELECT ins.id, ins.message, ins.created_at, u.id AS user_id, u.username, u.display_name
           FROM ins JOIN users u ON u.id=ins.user_id`,
          [blogId, userId, text],
        )).rows[0];
        await redis.publish(`chat:blog:${blogId}`, JSON.stringify({ type: 'message', message: saved }));
      } catch {
        send(ws, { type: 'error', error: 'Bad message' });
      }
    });
  }

  // Drop dead connections every 30s (ping -> expect pong).
  const timer = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!ws.alive) return ws.terminate();
      ws.alive = false;
      ws.ping();
    });
  }, 30000);

  return () => { clearInterval(timer); sub.disconnect(); wss.close(); };
}
