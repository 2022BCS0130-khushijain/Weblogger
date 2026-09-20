import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { HttpError, wrap, idParam } from '../utils.js';
import { requireAuth } from '../middleware/auth.js';
import { LIST, FROM, visibleTo, readableBlogById } from './blogs.js';

const router = Router();

async function ownedCollection(id, uid) {
  const c = (await query('SELECT * FROM collections WHERE id=$1', [id])).rows[0];
  if (!c) throw new HttpError(404, 'Collection not found');
  if (c.user_id !== uid) throw new HttpError(403, 'Not your collection');
  return c;
}

const schema = z.object({ name: z.string().trim().min(1).max(60), description: z.string().max(300).default('') });

router.get('/collections', requireAuth, wrap(async (req, res) => {
  const r = await query(
    `SELECT c.id, c.name, c.description, (SELECT count(*) FROM collection_blogs WHERE collection_id=c.id)::int AS blog_count
     FROM collections c WHERE c.user_id=$1 ORDER BY c.created_at DESC`, [req.userId]);
  res.json({ items: r.rows });
}));

router.post('/collections', requireAuth, wrap(async (req, res) => {
  const d = schema.parse(req.body);
  const r = await query('INSERT INTO collections(user_id, name, description) VALUES ($1,$2,$3) RETURNING *', [req.userId, d.name, d.description]);
  res.status(201).json(r.rows[0]);
}));

router.patch('/collections/:id', requireAuth, wrap(async (req, res) => {
  const c = await ownedCollection(idParam(req), req.userId);
  const d = schema.partial().parse(req.body);
  const r = await query('UPDATE collections SET name=COALESCE($2,name), description=COALESCE($3,description) WHERE id=$1 RETURNING *',
    [c.id, d.name ?? null, d.description ?? null]);
  res.json(r.rows[0]);
}));

router.delete('/collections/:id', requireAuth, wrap(async (req, res) => {
  const c = await ownedCollection(idParam(req), req.userId);
  await query('DELETE FROM collections WHERE id=$1', [c.id]);
  res.json({ deleted: true });
}));

router.get('/collections/:id/blogs', wrap(async (req, res) => {
  const c = (await query('SELECT id, name, description, user_id FROM collections WHERE id=$1', [idParam(req)])).rows[0];
  if (!c) throw new HttpError(404, 'Collection not found');
  const r = await query(
    `SELECT ${LIST} ${FROM} JOIN collection_blogs cb ON cb.blog_id=b.id AND cb.collection_id=$1
     WHERE ${visibleTo('$2')} ORDER BY cb.added_at DESC`, [c.id, req.userId ?? null]);
  res.json({ collection: c, items: r.rows });
}));

router.post('/collections/:id/blogs/:blogId', requireAuth, wrap(async (req, res) => {
  const c = await ownedCollection(idParam(req), req.userId);
  const b = await readableBlogById(idParam(req, 'blogId'), req.userId); // you can only add blogs you're allowed to see
  await query('INSERT INTO collection_blogs(collection_id, blog_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [c.id, b.id]);
  res.json({ added: true });
}));

router.delete('/collections/:id/blogs/:blogId', requireAuth, wrap(async (req, res) => {
  const c = await ownedCollection(idParam(req), req.userId);
  await query('DELETE FROM collection_blogs WHERE collection_id=$1 AND blog_id=$2', [c.id, idParam(req, 'blogId')]);
  res.json({ removed: true });
}));

export default router;
