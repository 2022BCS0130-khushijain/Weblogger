import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { redis } from '../redis.js';
import { HttpError, wrap, idParam, paging } from '../utils.js';
import { requireAuth } from '../middleware/auth.js';
import { emit } from '../events.js';
import { LIST, FROM, visibleTo } from './blogs.js';

const router = Router();

/** Numbers shown on a profile. `own` = include drafts/private blogs (used for the dashboard). */
async function stats(userId, own) {
  const pub = own ? 'TRUE' : "b.status='PUBLISHED' AND b.visibility='PUBLIC'";
  const r = await query(
    `SELECT
      (SELECT count(*) FROM blogs b WHERE b.author_id=$1 AND ${pub})::int AS blogs,
      (SELECT coalesce(sum(b.view_count),0) FROM blogs b WHERE b.author_id=$1 AND ${pub})::int AS views,
      (SELECT count(*) FROM blog_likes l JOIN blogs b ON b.id=l.blog_id WHERE b.author_id=$1 AND ${pub})::int AS likes,
      (SELECT count(*) FROM comments c JOIN blogs b ON b.id=c.blog_id WHERE b.author_id=$1 AND ${pub})::int AS comments,
      (SELECT count(*) FROM follows WHERE following_id=$1)::int AS followers,
      (SELECT count(*) FROM follows WHERE follower_id=$1)::int AS following`,
    [userId],
  );
  return r.rows[0];
}

async function userByName(username) {
  const u = (await query(
    'SELECT id, username, display_name, avatar_url, bio, created_at FROM users WHERE username=$1',
    [username.toLowerCase()],
  )).rows[0];
  if (!u) throw new HttpError(404, 'User not found');
  return u;
}

/* ---- me ---- (these must come BEFORE /users/:username) */
router.get('/users/me', requireAuth, wrap(async (req, res) => {
  const u = (await query(
    'SELECT id, username, display_name, avatar_url, bio, email, phone, created_at FROM users WHERE id=$1',
    [req.userId],
  )).rows[0];
  if (!u) throw new HttpError(401, 'Account no longer exists');
  res.json(u);
}));

const patchSchema = z.object({
  username: z.string().regex(/^[a-z0-9_]{3,30}$/, 'Username: 3-30 chars, a-z 0-9 _').optional(),
  display_name: z.string().min(1).max(60).optional(),
  bio: z.string().max(300).optional(),
  avatar_url: z.string().url().max(500).nullable().optional(),
});

router.patch('/users/me', requireAuth, wrap(async (req, res) => {
  const data = patchSchema.parse(req.body);
  const keys = Object.keys(data);
  if (!keys.length) throw new HttpError(400, 'Nothing to update');
  const sets = keys.map((k, i) => `${k}=$${i + 2}`).join(', ');
  const r = await query(
    `UPDATE users SET ${sets} WHERE id=$1 RETURNING id, username, display_name, avatar_url, bio, email, phone`,
    [req.userId, ...keys.map((k) => data[k])],
  ); // duplicate username -> Postgres error 23505 -> 409 by the error handler
  res.json(r.rows[0]);
}));

router.delete('/users/me', requireAuth, wrap(async (req, res) => {
  const slugs = (await query('SELECT slug FROM blogs WHERE author_id=$1', [req.userId])).rows;
  // ON DELETE CASCADE wipes their blogs, comments, likes, tokens... in one statement.
  await query('DELETE FROM users WHERE id=$1', [req.userId]);
  if (slugs.length) await redis.del(slugs.map((s) => `blog:slug:${s.slug}`)).catch(() => {});
  res.json({ deleted: true });
}));

/* ---- dashboard & personal lists ---- */
router.get('/me/dashboard', requireAuth, wrap(async (req, res) => {
  const totals = await stats(req.userId, true);
  const days = (await query(
    `SELECT to_char(d::date,'YYYY-MM-DD') AS day, coalesce(v.n,0)::int AS views
     FROM generate_series(now()::date - 29, now()::date, '1 day') d
     LEFT JOIN (
       SELECT bv.created_at::date AS day, count(*) AS n
       FROM blog_views bv JOIN blogs b ON b.id=bv.blog_id
       WHERE b.author_id=$1 AND bv.created_at > now() - interval '30 days' GROUP BY 1
     ) v ON v.day = d::date ORDER BY d`,
    [req.userId],
  )).rows;
  const top = (await query(
    `SELECT ${LIST} ${FROM} WHERE b.author_id=$1 AND b.status='PUBLISHED' ORDER BY b.view_count DESC LIMIT 5`,
    [req.userId],
  )).rows;
  res.json({ totals, viewsByDay: days, topBlogs: top });
}));

for (const [path, table] of [['bookmarks', 'bookmarks'], ['favorites', 'favorites']]) {
  router.get(`/me/${path}`, requireAuth, wrap(async (req, res) => {
    const { limit, offset } = paging(req);
    const r = await query(
      `SELECT ${LIST} ${FROM} JOIN ${table} t ON t.blog_id=b.id AND t.user_id=$1
       WHERE ${visibleTo('$1')} ORDER BY t.created_at DESC LIMIT $2 OFFSET $3`,
      [req.userId, limit, offset],
    );
    res.json({ items: r.rows });
  }));
}

/* ---- public profiles ---- */
router.get('/users/:username', wrap(async (req, res) => {
  const u = await userByName(req.params.username);
  const s = await stats(u.id, req.userId === u.id);
  let following = false;
  if (req.userId) {
    following = !!(await query('SELECT 1 FROM follows WHERE follower_id=$1 AND following_id=$2', [req.userId, u.id])).rowCount;
  }
  res.json({ ...u, stats: s, viewer: { isMe: req.userId === u.id, following } });
}));

router.get('/users/:username/blogs', wrap(async (req, res) => {
  const u = await userByName(req.params.username);
  const { limit, offset } = paging(req, 50, 100);
  const own = req.userId === u.id;
  const r = await query(
    `SELECT ${LIST} ${FROM} WHERE b.author_id=$1 AND ${visibleTo('$2')}
     ORDER BY ${own ? 'b.updated_at' : 'b.published_at'} DESC LIMIT $3 OFFSET $4`,
    [u.id, req.userId ?? null, limit, offset],
  );
  res.json({ items: r.rows });
}));

router.get('/users/:username/collections', wrap(async (req, res) => {
  const u = await userByName(req.params.username);
  const r = await query(
    `SELECT c.id, c.name, c.description,
       (SELECT count(*) FROM collection_blogs cb JOIN blogs b ON b.id=cb.blog_id
         WHERE cb.collection_id=c.id AND ${visibleTo('$2')})::int AS blog_count
     FROM collections c WHERE c.user_id=$1 ORDER BY c.created_at DESC`,
    [u.id, req.userId ?? null],
  );
  res.json({ items: r.rows });
}));

router.post('/users/:username/follow', requireAuth, wrap(async (req, res) => {
  const u = await userByName(req.params.username);
  if (u.id === req.userId) throw new HttpError(400, "You can't follow yourself");
  const r = await query('INSERT INTO follows(follower_id, following_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.userId, u.id]);
  if (r.rowCount) await emit({ type: 'follow', actorId: req.userId, targetUserId: u.id });
  res.json({ following: true });
}));

router.delete('/users/:username/follow', requireAuth, wrap(async (req, res) => {
  const u = await userByName(req.params.username);
  await query('DELETE FROM follows WHERE follower_id=$1 AND following_id=$2', [req.userId, u.id]);
  res.json({ following: false });
}));

export default router;
