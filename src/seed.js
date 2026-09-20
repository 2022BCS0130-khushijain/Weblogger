// `npm run seed` -> adds 3 demo users and a few blogs so the site isn't empty on first run.
import { pool, query } from './db.js';
import { runMigrations } from './migrate.js';

await runMigrations();

const users = [
  ['asha', 'asha@example.com', 'Asha Verma', 'Backend engineer. I like databases and queues.'],
  ['ravi', 'ravi@example.com', 'Ravi Kumar', 'Yoga teacher and weekend hiker.'],
  ['meera', 'meera@example.com', 'Meera Iyer', 'Watercolour painter.'],
];
for (const [username, email, name, bio] of users) {
  await query(
    `INSERT INTO users(username, email, display_name, bio) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
    [username, email, name, bio],
  );
}
const id = async (u) => (await query('SELECT id FROM users WHERE username=$1', [u])).rows[0].id;

const blogs = [
  ['asha', 'Technology', 'how-redis-caching-works', 'How Redis Caching Works', ['redis', 'caching', 'backend'],
    '# The idea\n\nA cache keeps a **copy** of data somewhere fast, so you do not ask the slow database every time.\n\n- Request comes in\n- Look in Redis first (a *hit* is instant)\n- On a *miss*, read Postgres, then store the answer in Redis with a **TTL**\n\n```\nGET blog:slug:how-kafka-works\n```\n\nThe hard part is knowing when to throw the cached copy away.'],
  ['asha', 'Technology', 'understanding-kafka-offsets', 'Understanding Kafka Offsets', ['kafka', 'distributed', 'backend'],
    'Kafka stores messages in an append-only log split into **partitions**. Each message has an *offset*, its position in the partition. Consumers remember the offset they reached, so they can resume exactly where they stopped.'],
  ['ravi', 'Yoga', 'a-gentle-morning-flow', 'A Gentle Morning Flow', ['yoga', 'morning'],
    'Start with five slow breaths. Move through cat-cow, downward dog, and a low lunge. Ten minutes is enough to wake the body without rushing.'],
  ['meera', 'Art', 'watercolor-wet-on-wet', 'Watercolor: Wet-on-Wet Technique', ['watercolor', 'painting'],
    'Wet the paper first, then touch in colour and watch it bloom. Timing matters: too wet and the pigment floods, too dry and the edges harden.'],
];
for (const [author, cat, slug, title, tags, content] of blogs) {
  await query(
    `INSERT INTO blogs(author_id, category_id, title, slug, content, tags, status, visibility, published_at)
     VALUES ($1, (SELECT id FROM categories WHERE name=$2), $3, $4, $5, $6, 'PUBLISHED', 'PUBLIC', now() - (random()*interval '5 days'))
     ON CONFLICT (slug) DO NOTHING`,
    [await id(author), cat, title, slug, content, tags],
  );
}
await query(`INSERT INTO follows(follower_id, following_id) VALUES ($1,$2),($3,$2) ON CONFLICT DO NOTHING`, [await id('ravi'), await id('asha'), await id('meera')]);
await query(
  `INSERT INTO blog_likes(blog_id, user_id) SELECT b.id, u.id FROM blogs b, users u WHERE b.slug='how-redis-caching-works' AND u.username IN ('ravi','meera') ON CONFLICT DO NOTHING`,
);
console.log('✔ demo data added. Log in with the developer login using asha@example.com, ravi@example.com or meera@example.com');
await pool.end();
