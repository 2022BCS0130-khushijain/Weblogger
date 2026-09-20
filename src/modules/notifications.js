import { Router } from 'express';
import { query } from '../db.js';
import { wrap, paging } from '../utils.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

/** Shape used both by the REST endpoint and by the worker when it pushes live over WebSocket. */
export const NOTIF_SELECT = `n.id, n.type, n.is_read, n.created_at, n.blog_id,
  a.username AS actor_username, a.display_name AS actor_name, b.title AS blog_title, b.slug AS blog_slug`;
export const NOTIF_FROM = `FROM notifications n JOIN users a ON a.id=n.actor_id LEFT JOIN blogs b ON b.id=n.blog_id`;

router.get('/notifications', requireAuth, wrap(async (req, res) => {
  const { limit, offset } = paging(req, 30);
  const items = (await query(
    `SELECT ${NOTIF_SELECT} ${NOTIF_FROM} WHERE n.user_id=$1 ORDER BY n.id DESC LIMIT $2 OFFSET $3`,
    [req.userId, limit, offset],
  )).rows;
  const unread = (await query('SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND NOT is_read', [req.userId])).rows[0].n;
  res.json({ unread, items });
}));

router.post('/notifications/read', requireAuth, wrap(async (req, res) => {
  await query('UPDATE notifications SET is_read=TRUE WHERE user_id=$1 AND NOT is_read', [req.userId]);
  res.json({ ok: true });
}));

export default router;
