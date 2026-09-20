import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { redis } from '../redis.js';
import { HttpError, wrap, idParam, slugify, randomToken } from '../utils.js';
import { requireAuth } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';

const router = Router();

/* ------------------------------------------------------------------ *
 * Shared SQL pieces, reused by feeds, search and profiles.
 * ------------------------------------------------------------------ */
export const LIST = `b.id, b.title, b.slug, left(b.content, 240) AS excerpt, b.tags, b.status, b.visibility,
  b.published_at, b.updated_at, b.view_count, b.share_count,
  u.username AS author_username, u.display_name AS author_name, u.avatar_url AS author_avatar,
  c.name AS category,
  (SELECT count(*) FROM blog_likes x WHERE x.blog_id=b.id)::int AS likes,
  (SELECT count(*) FROM comments x WHERE x.blog_id=b.id)::int AS comments,
  (SELECT count(*) FROM bookmarks x WHERE x.blog_id=b.id)::int AS bookmarks`;

export const FROM = `FROM blogs b JOIN users u ON u.id=b.author_id LEFT JOIN categories c ON c.id=b.category_id`;

/** SQL condition: "this blog is public, OR it belongs to the viewer". `p` is the placeholder of the viewer id. */
export const visibleTo = (p) => `((b.status='PUBLISHED' AND b.visibility='PUBLIC') OR b.author_id=${p})`;
export const PUBLIC_ONLY = `(b.status='PUBLISHED' AND b.visibility='PUBLIC')`;

const FULL = LIST.replace('left(b.content, 240) AS excerpt', 'b.content, b.author_id, b.category_id');

/* ------------------------------------------------------------------ *
 * Permission helpers  (authorization lives HERE, never in the frontend)
 * ------------------------------------------------------------------ */
export const isPublic = (b) => b.status === 'PUBLISHED' && b.visibility === 'PUBLIC';
export const canRead = (b, uid) => isPublic(b) || (uid != null && b.author_id === uid);

export async function findBlog(field, value) {
  const col = field === 'slug' ? 'b.slug' : 'b.id';
  return (await query(`SELECT ${FULL} ${FROM} WHERE ${col}=$1`, [value])).rows[0] || null;
}

/** Load a blog by id and make sure the viewer may see it. 404 = doesn't exist, 403 = not allowed. */
export async function readableBlogById(id, uid) {
  const b = await findBlog('id', id);
  if (!b) throw new HttpError(404, 'Blog not found');
  if (!canRead(b, uid)) throw new HttpError(403, 'You do not have access to this blog');
  return b;
}

async function ownedBlog(id, uid) {
  const b = await findBlog('id', id);
  if (!b) throw new HttpError(404, 'Blog not found');
  if (b.author_id !== uid) throw new HttpError(403, 'Only the author can do this');
  return b;
}

/* ------------------------------------------------------------------ *
 * Redis cache for public blog pages
 * ------------------------------------------------------------------ */
const cacheKey = (slug) => `blog:slug:${slug}`;
const CACHE_TTL = 60;
export const invalidate = (slug) => redis.del(cacheKey(slug)).catch(() => {});

/* ------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------ */
const tagsSchema = z.array(z.string().trim().toLowerCase().min(1).max(30)).max(10);
const createSchema = z.object({
  title: z.string().trim().min(1).max(200),
  content: z.string().max(200_000).default(''),
  category: z.string().nullable().optional(),
  tags: tagsSchema.optional(),
  slug: z.string().regex(/^[a-z0-9-]{3,80}$/, 'Slug: 3-80 chars, a-z 0-9 and -').optional(),
});
const patchSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  content: z.string().max(200_000).optional(),
  category: z.string().nullable().optional(),
  tags: tagsSchema.optional(),
  visibility: z.enum(['PUBLIC', 'PRIVATE']).optional(),
});

async function categoryId(name) {
  if (name === undefined) return undefined;
  if (name === null || name === '') return null;
  const r = await query('SELECT id FROM categories WHERE lower(name)=lower($1)', [name]);
  if (!r.rowCount) throw new HttpError(400, `Unknown category "${name}"`);
  return r.rows[0].id;
}

router.get('/categories', wrap(async (req, res) => {
  res.json({ items: (await query('SELECT id, name FROM categories ORDER BY name')).rows });
}));

/* ------------------------------------------------------------------ *
 * Create
 * ------------------------------------------------------------------ */
router.post('/blogs', requireAuth, rateLimit({ name: 'blog-create', limit: 30, windowSec: 3600, by: 'user' }), wrap(async (req, res) => {
  const d = createSchema.parse(req.body);
  const catId = (await categoryId(d.category)) ?? null;
  const base = d.slug || slugify(d.title);
  let slug = base;

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const r = await query(
        `INSERT INTO blogs(author_id, category_id, title, slug, content, tags)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, slug`,
        [req.userId, catId, d.title, slug, d.content, d.tags || []],
      );
      const full = await findBlog('id', r.rows[0].id);
      return res.status(201).json(full);
    } catch (e) {
      if (e.code !== '23505') throw e;
      if (d.slug) throw new HttpError(409, 'That slug is already taken');
      slug = `${base}-${randomToken(2)}`; // auto-generated slug clashed -> add a random suffix
    }
  }
  throw new HttpError(500, 'Could not generate a unique slug');
}));

/* ------------------------------------------------------------------ *
 * Read (cached)
 * ------------------------------------------------------------------ */
router.get('/blogs/:slug', wrap(async (req, res) => {
  const slug = req.params.slug;
  let blog = null;

  // 1) Try Redis first
  const cached = await redis.get(cacheKey(slug)).catch(() => null);
  if (cached) {
    blog = JSON.parse(cached);
  } else {
    // 2) Cache miss -> Postgres
    blog = await findBlog('slug', slug);
    if (!blog) throw new HttpError(404, 'Blog not found');
    // Only PUBLIC blogs are cached. Private/draft ones are always checked live.
    if (isPublic(blog)) await redis.set(cacheKey(slug), JSON.stringify(blog), 'EX', CACHE_TTL).catch(() => {});
  }

  // 3) Authorization is checked on EVERY request, even for cached blogs.
  if (!canRead(blog, req.userId)) throw new HttpError(403, 'You do not have access to this blog');

  // 4) Count a view (not for the author; once per viewer per 30 minutes)
  if (req.userId !== blog.author_id && isPublic(blog)) {
    const who = req.userId ?? `ip:${req.ip}`;
    const first = await redis.set(`view:${blog.id}:${who}`, '1', 'EX', 1800, 'NX').catch(() => null);
    if (first) {
      query('INSERT INTO blog_views(blog_id, user_id) VALUES ($1,$2)', [blog.id, req.userId ?? null]).catch(() => {});
      query('UPDATE blogs SET view_count = view_count + 1 WHERE id=$1', [blog.id]).catch(() => {});
    }
  }

  // 5) Per-user flags are not cached (they differ for each viewer)
  let viewer = { liked: false, bookmarked: false, favorited: false, isAuthor: false, following: false };
  if (req.userId) {
    const f = (await query(
      `SELECT EXISTS(SELECT 1 FROM blog_likes  WHERE blog_id=$1 AND user_id=$2) AS liked,
              EXISTS(SELECT 1 FROM bookmarks   WHERE blog_id=$1 AND user_id=$2) AS bookmarked,
              EXISTS(SELECT 1 FROM favorites   WHERE blog_id=$1 AND user_id=$2) AS favorited,
              EXISTS(SELECT 1 FROM follows     WHERE follower_id=$2 AND following_id=$3) AS following`,
      [blog.id, req.userId, blog.author_id],
    )).rows[0];
    viewer = { ...f, isAuthor: req.userId === blog.author_id };
  }
  res.json({ ...blog, viewer });
}));

/* ------------------------------------------------------------------ *
 * Update / publish / unpublish / delete   (author only)
 * ------------------------------------------------------------------ */
router.patch('/blogs/:id', requireAuth, wrap(async (req, res) => {
  const b = await ownedBlog(idParam(req), req.userId);
  const d = patchSchema.parse(req.body);

  const nextVisibility = d.visibility ?? b.visibility;
  if (b.status === 'DRAFT' && nextVisibility === 'PUBLIC') {
    throw new HttpError(400, 'A draft cannot be public. Publish it first.');
  }

  const cat = await categoryId(d.category);
  await query(
    `UPDATE blogs SET
       title = COALESCE($2, title), content = COALESCE($3, content), tags = COALESCE($4, tags),
       category_id = CASE WHEN $5::boolean THEN $6::int ELSE category_id END,
       visibility = $7, updated_at = now()
     WHERE id=$1`,
    [b.id, d.title ?? null, d.content ?? null, d.tags ?? null, cat !== undefined, cat ?? null, nextVisibility],
  );
  await invalidate(b.slug);
  res.json(await findBlog('id', b.id));
}));

router.post('/blogs/:id/publish', requireAuth, wrap(async (req, res) => {
  const b = await ownedBlog(idParam(req), req.userId);
  const { visibility } = z.object({ visibility: z.enum(['PUBLIC', 'PRIVATE']).default('PUBLIC') }).parse(req.body || {});
  if (!b.title.trim() || !b.content.trim()) throw new HttpError(400, 'Add a title and some content before publishing');
  await query(
    `UPDATE blogs SET status='PUBLISHED', visibility=$2, published_at=COALESCE(published_at, now()), updated_at=now() WHERE id=$1`,
    [b.id, visibility],
  );
  await invalidate(b.slug);
  res.json(await findBlog('id', b.id));
}));

router.post('/blogs/:id/unpublish', requireAuth, wrap(async (req, res) => {
  const b = await ownedBlog(idParam(req), req.userId);
  await query(`UPDATE blogs SET status='DRAFT', visibility='PRIVATE', updated_at=now() WHERE id=$1`, [b.id]);
  await invalidate(b.slug);
  res.json(await findBlog('id', b.id));
}));

router.delete('/blogs/:id', requireAuth, wrap(async (req, res) => {
  const b = await ownedBlog(idParam(req), req.userId);
  await query('DELETE FROM blogs WHERE id=$1', [b.id]);
  await invalidate(b.slug);
  res.json({ deleted: true });
}));

export default router;
