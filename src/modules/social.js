import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { query } from '../db.js';
import { HttpError, wrap, idParam, paging } from '../utils.js';
import { requireAuth } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { emit } from '../events.js';
import { readableBlogById, invalidate } from './blogs.js';

const router = Router();

/* ---- Like / Bookmark / Favorite ----
 * All three are the same idea: a row in a table means "on".
 * PRIMARY KEY(user_id, blog_id) + ON CONFLICT DO NOTHING => pressing twice is harmless.
 */
const toggles = [
  ['like', 'blog_likes'],
  ['bookmark', 'bookmarks'],
  ['favorite', 'favorites'],
];

for (const [name, table] of toggles) {
  router.post(`/blogs/:id/${name}`, requireAuth, rateLimit({ name, limit: 120, windowSec: 60, by: 'user' }), wrap(async (req, res) => {
    const b = await readableBlogById(idParam(req), req.userId);
    const r = await query(`INSERT INTO ${table}(blog_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [b.id, req.userId]);
    if (name === 'like' && r.rowCount) {
      await emit({ type: 'like', actorId: req.userId, targetUserId: b.author_id, blogId: b.id });
    }
    await invalidate(b.slug); // counts changed -> drop the cached copy
    res.json({ active: true });
  }));

  router.delete(`/blogs/:id/${name}`, requireAuth, wrap(async (req, res) => {
    const b = await readableBlogById(idParam(req), req.userId);
    await query(`DELETE FROM ${table} WHERE blog_id=$1 AND user_id=$2`, [b.id, req.userId]);
    await invalidate(b.slug);
    res.json({ active: false });
  }));
}

/* ---- Share ---- */
router.post('/blogs/:id/share', wrap(async (req, res) => {
  const { via } = z.object({ via: z.enum(['link', 'whatsapp', 'x']).default('link') }).parse(req.body || {});
  const b = await readableBlogById(idParam(req), req.userId);
  if (b.visibility !== 'PUBLIC') throw new HttpError(400, 'Only public blogs can be shared');
  await query('UPDATE blogs SET share_count = share_count + 1 WHERE id=$1', [b.id]);
  await invalidate(b.slug);
  res.json({ url: `${config.publicUrl}/blog/${b.slug}`, via });
}));

/* ---- Comments (with replies) ---- */
router.get('/blogs/:id/comments', wrap(async (req, res) => {
  const b = await readableBlogById(idParam(req), req.userId);
  const { limit, offset } = paging(req, 200, 500);
  const r = await query(
    `SELECT c.id, c.parent_comment_id, c.content, c.created_at, c.updated_at, c.user_id,
            u.username, u.display_name, u.avatar_url
     FROM comments c JOIN users u ON u.id=c.user_id
     WHERE c.blog_id=$1 ORDER BY c.created_at ASC LIMIT $2 OFFSET $3`,
    [b.id, limit, offset],
  );
  res.json({ items: r.rows }); // flat list; the client turns parent_comment_id into a tree
}));

router.post('/blogs/:id/comments', requireAuth, rateLimit({ name: 'comment', limit: 10, windowSec: 60, by: 'user' }), wrap(async (req, res) => {
  const b = await readableBlogById(idParam(req), req.userId);
  const { content, parent_comment_id } = z.object({
    content: z.string().trim().min(1).max(2000),
    parent_comment_id: z.number().int().positive().nullable().optional(),
  }).parse(req.body);

  let parent = null;
  if (parent_comment_id) {
    parent = (await query('SELECT id, user_id FROM comments WHERE id=$1 AND blog_id=$2', [parent_comment_id, b.id])).rows[0];
    if (!parent) throw new HttpError(400, 'Parent comment not found on this blog');
  }

  const r = await query(
    `INSERT INTO comments(blog_id, user_id, parent_comment_id, content) VALUES ($1,$2,$3,$4) RETURNING id`,
    [b.id, req.userId, parent?.id ?? null, content],
  );
  if (parent) await emit({ type: 'reply', actorId: req.userId, targetUserId: parent.user_id, blogId: b.id });
  await emit({ type: 'comment', actorId: req.userId, targetUserId: b.author_id, blogId: b.id });
  await invalidate(b.slug);

  const row = (await query(
    `SELECT c.id, c.parent_comment_id, c.content, c.created_at, c.updated_at, c.user_id, u.username, u.display_name, u.avatar_url
     FROM comments c JOIN users u ON u.id=c.user_id WHERE c.id=$1`, [r.rows[0].id])).rows[0];
  res.status(201).json(row);
}));

router.delete('/comments/:id', requireAuth, wrap(async (req, res) => {
  const c = (await query(
    `SELECT c.id, c.user_id, b.author_id, b.slug FROM comments c JOIN blogs b ON b.id=c.blog_id WHERE c.id=$1`,
    [idParam(req)],
  )).rows[0];
  if (!c) throw new HttpError(404, 'Comment not found');
  // The comment's writer OR the blog's author may delete it.
  if (c.user_id !== req.userId && c.author_id !== req.userId) throw new HttpError(403, 'Not allowed');
  await query('DELETE FROM comments WHERE id=$1', [c.id]); // replies are removed by ON DELETE CASCADE
  await invalidate(c.slug);
  res.json({ deleted: true });
}));

export default router;
