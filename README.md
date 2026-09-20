# ✒️ Inkwell — a blogging platform (backend-heavy portfolio project)

Inkwell is a small blogging **platform**, not just a blog site. People log in, write blogs (drafts, private, public),
like / comment / bookmark them, search **inside** blog text, follow authors, chat live under a blog, and get notifications.

It is built as a **modular monolith**: one backend program, split into clean modules, backed by **PostgreSQL** (data) and **Redis** (speed + real-time).

> **Tested:** 29 automated end-to-end tests pass against real Postgres + Redis (auth, permissions, caching, rate limits,
> search, feeds, worker, WebSocket chat & notifications), and the web page was tested in a simulated browser.

---

## 1. Setup (pick ONE way)

### Way A — Docker (easiest, 1 command)

You need [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed.

```bash
unzip inkwell.zip && cd inkwell
docker compose up --build
```

Open **http://localhost:3000**. That's it. Postgres and Redis start automatically.

### Way B — Run on your own machine

You need: **Node.js 20+**, **PostgreSQL 14+**, **Redis 6+** (all running).

```bash
unzip inkwell.zip && cd inkwell

# 1. create the database (one time)
psql -U postgres -c "CREATE USER bloguser WITH PASSWORD 'blogpass';" \
                 -c "CREATE DATABASE blogdb OWNER bloguser;"

# 2. install + configure
npm install
cp .env.example .env          # the defaults already match the database above

# 3. (optional) add demo users and blogs
npm run seed

# 4. start
npm start
```

Open **http://localhost:3000**. Tables are created automatically at startup.

### First 2 minutes in the app

1. Click **Log in → Developer login**, type any email (e.g. `asha@example.com` if you ran the seed). You're in.
2. Click **✎ Write**, add a title + text, press **Publish publicly**.
3. Open the blog in a second browser window (different email) → like it, comment, reply.
4. On the blog page, use **Live discussion**: type in one window, watch it appear in the other instantly.
5. Try the search box: it finds words *inside* blog content.

### Run the tests

Start the server (`npm start`) in one terminal, then in another:

```bash
npm test
```

---

## 2. What was built (mapped to your design)

| Your design section | Where it lives | Status |
|---|---|---|
| Google OAuth, Phone OTP, JWT + refresh, logout, delete account | `src/modules/auth.js`, `users.js` | ✅ Google needs your client ID (see §7); OTP uses a console "SMS stub" |
| Profile, stats, follow | `src/modules/users.js` | ✅ |
| Blogs, unique slugs, Draft/Published × Public/Private | `src/modules/blogs.js`, `db/schema.sql` | ✅ (the invalid combo is blocked by the API *and* a DB constraint) |
| Likes / Bookmarks / Favorites / Share | `src/modules/social.js` | ✅ |
| Comments with replies | `src/modules/social.js` | ✅ |
| Collections (user-made groups) | `src/modules/collections.js` | ✅ |
| Full-text search inside content | `src/modules/discovery.js` | ✅ PostgreSQL full-text search (GIN index, ranked, highlighted) |
| Latest / Trending / Following / For-you feeds, Related blogs | `src/modules/discovery.js` | ✅ (rule-based, no AI yet) |
| Redis: caching, rate limiting, pub/sub | `blogs.js`, `middleware/rateLimit.js`, `realtime.js` | ✅ |
| Real-time chat (WebSocket + Redis Pub/Sub) | `src/modules/realtime.js` | ✅ |
| Notifications via queue + worker | `src/events.js`, `src/worker.js` | ✅ (Redis list as the queue) |
| Dashboard (views/likes, 30-day chart, top blogs) | `users.js` (`/me/dashboard`) | ✅ |
| Indexes & unique constraints | `db/schema.sql` | ✅ |
| Docker | `Dockerfile`, `docker-compose.yml` | ✅ |

**Deliberately left out (as your doc advised — "add only when you have a real reason"):**
Kafka/Elasticsearch, pgvector embeddings (AI recommendations), S3 image uploads (avatars are just a URL for now),
AWS/Nginx/GitHub Actions, real SMS sending.

**Two choices that differ from the doc:**
- **Node.js instead of Go**, and a plain HTML/JS frontend instead of Next.js. I picked what I could run and test end-to-end here.
  The design (tables, endpoints, Redis usage, worker) is language-independent, so it ports 1:1 to Go + Chi/Gin later — a great next exercise.
- **Chat messages** are stored in one `chat_messages` table keyed by `blog_id` (no separate `chat_rooms` table — a room *is* a blog).

---

## 3. How it works — the easy version

### The restaurant analogy

| Restaurant | Inkwell |
|---|---|
| Customer | Browser |
| Waiter (takes orders, checks who you are) | **Express API** (`src/server.js` + modules) |
| Kitchen's permanent pantry | **PostgreSQL** (all real data lives here) |
| Fridge next to the chef (fast, temporary) | **Redis** (cache, counters, message passing) |
| Kitchen helper working in the background | **Worker** (`src/worker.js`) |
| Intercom between tables | **WebSockets** (live chat & notifications) |

### The folder map

```
inkwell/
├── db/schema.sql            ← every table + index + rule (run automatically on start)
├── src/
│   ├── server.js            ← starts everything; wires routes; central error handling
│   ├── config.js            ← reads .env
│   ├── db.js  redis.js      ← connections to Postgres and Redis
│   ├── utils.js             ← small helpers (slugify, HttpError...)
│   ├── events.js            ← "something happened" → drop a message in a Redis queue
│   ├── worker.js            ← picks messages from the queue, creates notifications
│   ├── seed.js  migrate.js  ← demo data / create tables
│   ├── middleware/
│   │   ├── auth.js          ← reads the login token from each request
│   │   └── rateLimit.js     ← "max N requests per minute" using Redis
│   └── modules/
│       ├── auth.js          ← Google, phone OTP, refresh, logout
│       ├── users.js         ← profiles, stats, follow, dashboard, delete account
│       ├── blogs.js         ← create/read/edit/publish/delete + permissions + cache
│       ├── social.js        ← like, bookmark, favorite, share, comments
│       ├── collections.js   ← user-made groups of blogs
│       ├── discovery.js     ← search, feeds, related blogs
│       ├── notifications.js ← list / mark as read
│       └── realtime.js      ← WebSocket chat + live notifications
├── public/                  ← the website (index.html, style.css, app.js)
└── test/api.test.js         ← 29 end-to-end tests
```

### Life of one request (example: "open a blog")

```
Browser: GET /api/blogs/how-kafka-works        (+ login token, if logged in)
   │
   ▼
1. optionalAuth      → reads the token, learns "this is user #7" (or anonymous)
2. Redis             → is this blog already cached?  (blog:slug:how-kafka-works)
      ├─ yes → use it (very fast)
      └─ no  → ask PostgreSQL, then save it in Redis for 60 seconds
3. Permission check  → public? or is the viewer the author?   No → 403
4. Count the view    → once per person per 30 min (Redis remembers who already viewed)
5. Add "did I like it?" flags for this viewer (not cached, differs per person)
6. Send JSON back
```

The important habit: **the server checks permissions on every request**, even when the data came from the cache.
The frontend hides buttons for convenience, but it is never trusted.

### Login (authentication)

```
Log in (Google / phone OTP)
        │
        ▼
Server returns TWO tokens
 ├─ access token  : lives 15 minutes, sent with every request (JWT, signed with JWT_SECRET)
 └─ refresh token : lives 30 days, used only to get a new access token
```

- **Why two?** If an access token is stolen, it dies in 15 minutes. The long-lived refresh token is used rarely.
- **Refresh tokens rotate:** each use deletes the old one and issues a new one. Only a *hash* is stored in the database.
- **Phone OTP:** a 6-digit code is created, only its **hash** is stored in Redis for 5 minutes, max 5 wrong tries, single use.
  Sending is rate-limited (3 per phone per 10 min, 10 per IP per hour) so nobody can spam SMS.
  In development the code is shown on screen and printed in the server console; in production you plug an SMS provider into one marked spot in `auth.js`.
- We never store passwords (there aren't any).

### Blog states and permissions

Two independent switches:

| status | visibility | meaning |
|---|---|---|
| DRAFT | PRIVATE | work in progress — only you |
| PUBLISHED | PUBLIC | everyone can read |
| PUBLISHED | PRIVATE | published but only you can see it |
| DRAFT | PUBLIC | ❌ impossible (API rejects it **and** the database has a `CHECK` rule) |

Rules, all in `blogs.js`: anyone can read public blogs; only the author can read private ones, edit, publish, unpublish or delete.
Wrong person → `403 Forbidden`; blog doesn't exist → `404`.

**Slugs:** the URL name is made from the title (`How Kafka Works` → `how-kafka-works`). It's `UNIQUE` in the database.
If two people pick the same title, a short random suffix is added. Slugs never change after creation so shared links don't break.

### Likes, bookmarks, favorites

Each is a table with one row per (user, blog) and `PRIMARY KEY (user_id, blog_id)`.
Pressing Like 20 times inserts one row (`ON CONFLICT DO NOTHING`). The count is `COUNT(*)` of rows — never a number you could get out of sync.
*Bookmark* = "read later"; *Favorite* = "I love this".

### Comments

A comment can have a `parent_comment_id`, which makes replies. The API returns a flat list; the browser builds the tree.
Deleting a parent deletes its replies automatically (`ON DELETE CASCADE`). The comment writer **or** the blog author may delete a comment. Posting is limited to 10 per minute.

### Collections

Users create their own groups ("Backend Engineering", "Travel Stories") and add blogs to them. You can only add blogs you're allowed to see.
On a profile, blogs are also grouped by their category.

### Search (inside the text)

Every blog has a hidden `search` column that Postgres keeps updated (via a trigger) with the *processed words* of title (most important), tags, then content.
A **GIN index** makes searching that column fast. `GET /api/search?q=distributed systems` understands stemming
(searching "partition" also finds "partitions"), ranks results by relevance, and returns a snippet with the matching words highlighted.
Private blogs never appear for other users.

### Feeds

- **Latest** — newest published first.
- **Trending** — `(likes×3 + comments×5 + bookmarks×4 + views) ÷ (age_in_hours + 2)^1.5`. Newer + more engagement = higher. Cached 60 s in Redis.
- **Following** — blogs from people you follow.
- **For you** — looks at what you liked/saved/viewed, collects those categories and tags, and ranks unseen blogs by overlap.
- **Related** (under each blog) — same category + shared tags.

### Redis — what it's used for here

| Use | How |
|---|---|
| **Cache** public blog pages | key `blog:slug:<slug>`, 60 s, deleted whenever the blog changes |
| **Rate limiting** | `INCR key` + `EXPIRE` → "N per window" → `429 Too Many Requests` |
| **OTP storage** | hashed code with 5 min expiry |
| **View de-duplication** | `SET key NX EX 1800` — only the first view per person per 30 min counts |
| **Queue** | a Redis list `queue:events` (`LPUSH` in, `BRPOP` out) |
| **Pub/Sub** | channels `chat:blog:<id>` and `notify:user:<id>` |

If Redis goes down, rate limiting and caching **fail open** (the site keeps working, just slower and less protected).

### Live chat (WebSocket)

```
Alice's browser ──ws──► server ──save──► Postgres
                          │
                          └──PUBLISH──► Redis "chat:blog:12"
                                            │  (every server copy is subscribed)
                                            ▼
                    Bob's + Alice's + everyone's browser in that room
```

- Connect to `/ws/chat/blog/:id?token=<access token>`. The same permission rule applies: no access to the blog → no chat (403).
- A newcomer immediately receives the last 50 messages.
- Max 5 messages / 5 seconds per user. Because messages go through Redis Pub/Sub, you can run **several** server copies and chat still works between them.
- **Comments vs chat:** comments are the permanent discussion; chat is the live, casual one.

### Notifications (queue + worker)

```
Bob likes Alice's blog
   API: saves the like, drops {type:'like',...} into Redis queue, replies immediately
                                   │
                    Worker (background loop) picks it up
                                   │
                  saves a row in `notifications` table
                                   │
             PUBLISH to Redis "notify:user:<alice>"
                                   │
       Alice's open browser gets it over WebSocket → 🔔 toast + badge
```

Why a queue? The API answers Bob faster, and if the notification step is slow or crashes, the like still succeeded.
By default the worker runs *inside* the API process (`RUN_WORKER_INLINE=true`). For production set it to `false` and run `npm run worker` as a separate process — no code changes.

### Dashboard

`GET /api/me/dashboard` → totals (views, likes, comments, blogs, followers), views per day for 30 days
(`generate_series` + `GROUP BY` so empty days show 0), and your top blogs.

### Security notes (already handled)

- SQL is always parameterized (`$1, $2`) → no SQL injection.
- Blog text is **never** inserted as raw HTML: the frontend escapes everything, then converts a few markdown patterns. Tested with `<script>` and `javascript:` attacks.
- All inputs validated with Zod → clean `400` errors.
- Rate limits on OTP, comments, blog creation, search, likes, chat.
- Access tokens are short-lived; refresh tokens are hashed and rotated.

---

## 4. API cheat sheet

All under `/api`. 🔒 = needs `Authorization: Bearer <accessToken>`.

| Area | Endpoints |
|---|---|
| Auth | `POST /auth/google` · `POST /auth/phone/send` · `POST /auth/phone/verify` · `POST /auth/refresh` · `POST /auth/logout` · `POST /auth/dev-login` (dev only) |
| Users | `GET /users/:username` · `GET /users/:username/blogs` · `GET /users/:username/collections` · 🔒 `GET/PATCH/DELETE /users/me` · 🔒 `POST/DELETE /users/:username/follow` |
| Blogs | 🔒 `POST /blogs` · `GET /blogs/:slug` · 🔒 `PATCH /blogs/:id` · 🔒 `POST /blogs/:id/publish` · 🔒 `POST /blogs/:id/unpublish` · 🔒 `DELETE /blogs/:id` · `GET /categories` |
| Social | 🔒 `POST/DELETE /blogs/:id/like` · `…/bookmark` · `…/favorite` · `POST /blogs/:id/share` |
| Comments | `GET /blogs/:id/comments` · 🔒 `POST /blogs/:id/comments` (`parent_comment_id` for replies) · 🔒 `DELETE /comments/:id` |
| Collections | 🔒 `GET/POST /collections` · 🔒 `PATCH/DELETE /collections/:id` · `GET /collections/:id/blogs` · 🔒 `POST/DELETE /collections/:id/blogs/:blogId` |
| Discovery | `GET /search?q=` · `GET /feed/latest` · `GET /feed/trending` · 🔒 `GET /feed/following` · 🔒 `GET /feed/recommended` · `GET /blogs/:id/related` |
| Me | 🔒 `GET /me/dashboard` · 🔒 `GET /me/bookmarks` · 🔒 `GET /me/favorites` · 🔒 `GET /notifications` · 🔒 `POST /notifications/read` |
| Real-time | `WS /ws/chat/blog/:id?token=…` · `WS /ws/notifications?token=…` |
| Other | `GET /health` |

List endpoints accept `?page=1&limit=20`.

Quick try with curl:

```bash
# get a token
curl -s -X POST localhost:3000/api/auth/dev-login -H 'Content-Type: application/json' \
     -d '{"email":"me@example.com","name":"Me"}'
# use it
curl -s localhost:3000/api/users/me -H "Authorization: Bearer PASTE_ACCESS_TOKEN"
```

---

## 5. Configuration (`.env`)

| Variable | Meaning | Default |
|---|---|---|
| `PORT` | web port | `3000` |
| `NODE_ENV` | `development` shows dev login + OTP on screen. `production` hides both | `development` |
| `PUBLIC_URL` | used to build share links | `http://localhost:3000` |
| `DATABASE_URL` | Postgres connection | `postgres://bloguser:blogpass@localhost:5432/blogdb` |
| `REDIS_URL` | Redis connection | `redis://localhost:6379` |
| `JWT_SECRET` | signs login tokens — **must** be long & random in production (the app refuses to start otherwise) | dev value |
| `GOOGLE_CLIENT_ID` | enables "Sign in with Google" | empty (disabled) |
| `RUN_WORKER_INLINE` | run the notification worker inside the API process | `true` |
| `TRUST_PROXY` | set `true` when behind Nginx / a load balancer so rate limiting sees real IPs | `false` |

---

## 6. Database tables (quick reference)

`users` · `refresh_tokens` · `categories` · `blogs` (+ `search` column) · `blog_likes` · `bookmarks` · `favorites` · `blog_views` ·
`comments` · `collections` · `collection_blogs` · `follows` · `chat_messages` · `notifications`

Indexes worth explaining in an interview (all in `db/schema.sql`):

- `blogs(published_at DESC) WHERE PUBLISHED & PUBLIC` — a *partial index* that makes the "Latest" feed fast and small.
- `GIN(search)` — full-text search.
- `GIN(tags)` — tag lookups.
- `blogs(author_id)`, `comments(blog_id, created_at)`, `blog_views(blog_id, created_at)` — the columns the app filters by.
- `PRIMARY KEY (user_id, blog_id)` on likes/bookmarks/favorites — prevents duplicates *and* serves as the index.
- `UNIQUE` on `users.username`, `users.email`, `users.phone`, `blogs.slug`.

---

## 7. Enabling Google login (optional)

1. Go to <https://console.cloud.google.com/apis/credentials> → **Create credentials → OAuth client ID → Web application**.
2. Add `http://localhost:3000` under **Authorized JavaScript origins**.
3. Copy the client ID into `.env` as `GOOGLE_CLIENT_ID=...` and restart.
4. A "Sign in with Google" button appears on the login page. The browser gets a Google ID token, the server **verifies it with Google's library**, then creates/finds the user and issues *our* tokens.

## 8. Before deploying for real

- `NODE_ENV=production`, a long random `JWT_SECRET`, real `GOOGLE_CLIENT_ID`, real `PUBLIC_URL`.
- Plug an SMS provider into `POST /auth/phone/send` (the spot is marked `TODO`).
- Put Nginx / a load balancer in front with HTTPS; set `TRUST_PROXY=true`.
- Run the worker separately (`RUN_WORKER_INLINE=false`, `npm run worker`).
- The tokens are kept in `localStorage` for simplicity. For a hardened setup, move the refresh token into an `HttpOnly` cookie.

## 9. Good next steps (in the order I'd do them)

1. **Port the backend to Go** (Chi/Gin + `pgx` + `go-redis`) — the design maps one-to-one; use the tests here as your contract (they only talk HTTP/WebSocket).
2. Replace the textarea with a real rich editor and add **autosave**.
3. **S3 image uploads** (pre-signed URLs) for avatars and blog images.
4. **pgvector**: create an embedding per blog in the worker, then power "Related" / "For you" with vector similarity.
5. Move search to Elasticsearch/OpenSearch *only if* Postgres search becomes a bottleneck (feed it through Kafka as in your diagram).
6. Materialized views or a nightly job for the dashboard and trending scores at large scale.
7. GitHub Actions (run `npm test` against Postgres + Redis service containers), then deploy to AWS.

## 10. Troubleshooting

| Problem | Fix |
|---|---|
| `ECONNREFUSED 5432` | Postgres isn't running, or the `DATABASE_URL` is wrong. |
| `ECONNREFUSED 6379` | Redis isn't running. (Start it: `redis-server`.) |
| `password authentication failed` | Re-run the `CREATE USER ... PASSWORD 'blogpass'` command, or edit `.env`. |
| Port 3000 already in use | Change `PORT` in `.env` (and `PUBLIC_URL`). |
| Tests fail with `fetch failed` | The server isn't running — start it with `npm start` first. |
| Wanted to see OTP but nothing shows | Check the terminal running the server: `📱 [SMS stub] OTP for +91…: 123456`. |
