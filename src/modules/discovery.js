import { Router } from 'express';
import { query } from '../db.js';
import { redis } from '../redis.js';
import { HttpError, wrap, idParam, paging } from '../utils.js';
import { requireAuth } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { LIST, FROM, visibleTo, PUBLIC_ONLY, readableBlogById } from './blogs.js';

const router = Router();

/* ------------------------------------------------------------------ *
 * SEARCH — PostgreSQL full-text search over title + tags + content.
 * websearch_to_tsquery understands normal input like:  kafka "consumer group" -zookeeper
 * ------------------------------------------------------------------ */
router.get('/search', rateLimit({ name: 'search', limit: 60, windowSec: 60 }), wrap(async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 200);
  if (!q) throw new HttpError(400, 'Missing search text (?q=...)');
  const { page, limit, offset } = paging(req);

  const r = await query(
    `SELECT ${LIST},
            ts_rank_cd(b.search, tsq) AS rank,
            ts_headline('english', b.content, tsq, 'StartSel=[[,StopSel=]],MaxWords=30,MinWords=12') AS snippet
     ${FROM}, websearch_to_tsquery('english', $1) AS tsq
     WHERE b.search @@ tsq AND ${visibleTo('$2')}
     ORDER BY rank DESC, b.published_at DESC NULLS LAST
     LIMIT $3 OFFSET $4`,
    [q, req.userId ?? null, limit, offset],
  );
  res.json({ q, page, items: r.rows });
}));

/* ------------------------------------------------------------------ *
 * FEEDS
 * ------------------------------------------------------------------ */
router.get('/feed/latest', wrap(async (req, res) => {
  const { page, limit, offset } = paging(req);
  const cat = req.query.category ? String(req.query.category) : null;
  const r = await query(
    `SELECT ${LIST} ${FROM}
     WHERE ${PUBLIC_ONLY} AND ($3::text IS NULL OR lower(c.name)=lower($3))
     ORDER BY b.published_at DESC LIMIT $1 OFFSET $2`,
    [limit, offset, cat],
  );
  res.json({ page, items: r.rows });
}));

/**
 * TRENDING: engagement score that fades with age (like Hacker News):
 *   score = (likes*3 + comments*5 + bookmarks*4 + views) / (age_in_hours + 2)^1.5
 * Cached in Redis for 60 seconds because it scans many rows.
 */
router.get('/feed/trending', wrap(async (req, res) => {
  const { page, limit, offset } = paging(req);
  const key = `feed:trending:${page}:${limit}`;
  const hit = await redis.get(key).catch(() => null);
  if (hit) return res.json(JSON.parse(hit));

  const r = await query(
    `SELECT t.*, ((t.likes*3 + t.comments*5 + t.bookmarks*4 + t.view_count)::float
                  / power(extract(epoch FROM (now() - t.published_at))/3600.0 + 2, 1.5)) AS score
     FROM (SELECT ${LIST} ${FROM} WHERE ${PUBLIC_ONLY}) t
     ORDER BY score DESC LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  const body = { page, items: r.rows };
  await redis.set(key, JSON.stringify(body), 'EX', 60).catch(() => {});
  res.json(body);
}));

router.get('/feed/following', requireAuth, wrap(async (req, res) => {
  const { page, limit, offset } = paging(req);
  const r = await query(
    `SELECT ${LIST} ${FROM} JOIN follows f ON f.following_id=b.author_id AND f.follower_id=$1
     WHERE ${PUBLIC_ONLY} ORDER BY b.published_at DESC LIMIT $2 OFFSET $3`,
    [req.userId, limit, offset],
  );
  res.json({ page, items: r.rows });
}));

/**
 * RECOMMENDED ("For you"): look at blogs the user liked / bookmarked / favorited / viewed,
 * collect their categories and tags, then rank other public blogs by how many they share.
 * (Simple and explainable. The design doc's next step is embeddings + pgvector.)
 */
router.get('/feed/recommended', requireAuth, wrap(async (req, res) => {
  const { page, limit, offset } = paging(req);
  const r = await query(
    `WITH seen AS (
       SELECT blog_id FROM blog_likes WHERE user_id=$1
       UNION SELECT blog_id FROM bookmarks WHERE user_id=$1
       UNION SELECT blog_id FROM favorites WHERE user_id=$1
       UNION SELECT blog_id FROM blog_views WHERE user_id=$1
     ),
     my_tags AS (SELECT DISTINCT unnest(tags) AS tag FROM blogs WHERE id IN (SELECT blog_id FROM seen)),
     my_cats AS (SELECT DISTINCT category_id FROM blogs WHERE id IN (SELECT blog_id FROM seen) AND category_id IS NOT NULL)
     SELECT ${LIST},
       (COALESCE((b.category_id IN (SELECT category_id FROM my_cats))::int, 0)
        + 2 * (SELECT count(*) FROM unnest(b.tags) t WHERE t IN (SELECT tag FROM my_tags))) AS score
     ${FROM}
     WHERE ${PUBLIC_ONLY} AND b.author_id <> $1 AND b.id NOT IN (SELECT blog_id FROM seen)
     ORDER BY score DESC, b.published_at DESC LIMIT $2 OFFSET $3`,
    [req.userId, limit, offset],
  );
  res.json({ page, items: r.rows });
}));

/** "Related blogs" shown under an article: same category and shared tags. */
router.get('/blogs/:id/related', wrap(async (req, res) => {
  const b = await readableBlogById(idParam(req), req.userId);
  const r = await query(
    `SELECT ${LIST},
       (COALESCE((b.category_id = $2::int)::int, 0)
        + 2 * cardinality(ARRAY(SELECT unnest(b.tags) INTERSECT SELECT unnest($3::text[])))) AS score
     ${FROM}
     WHERE ${PUBLIC_ONLY} AND b.id <> $1
     ORDER BY score DESC, b.published_at DESC LIMIT 5`,
    [b.id, b.category_id ?? null, b.tags],
  );
  res.json({ items: r.rows });
}));

export default router;
