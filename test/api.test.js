// End-to-end tests. They talk to a RUNNING server (start it first: `npm start`).
//   npm test                      -> tests http://localhost:3000
//   TEST_URL=http://localhost:3100 npm test
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';

const BASE = process.env.TEST_URL || 'http://localhost:3000';
const run = Date.now().toString(36); // makes emails/slugs unique on every run

async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data, headers: res.headers };
}
const login = async (name) => {
  const r = await api('POST', '/auth/dev-login', { body: { email: `${name}-${run}@test.dev`, name } });
  assert.equal(r.status, 200);
  return r.data;
};

let alice, bob, blog;

before(async () => {
  alice = await login('alice');
  bob = await login('bob');
});

test('health check', async () => {
  const r = await api('GET', '/health');
  assert.equal(r.data.ok, true);
});

test('requests without a token are rejected', async () => {
  assert.equal((await api('POST', '/blogs', { body: { title: 'x' } })).status, 401);
  assert.equal((await api('GET', '/users/me')).status, 401);
});

test('create a blog -> starts as private DRAFT with a slug', async () => {
  const r = await api('POST', '/blogs', {
    token: alice.accessToken,
    body: { title: `How Kafka Works ${run}`, content: 'Kafka is a distributed log. Consumers read offsets from partitions.', category: 'Technology', tags: ['kafka', 'Distributed'] },
  });
  assert.equal(r.status, 201);
  blog = r.data;
  assert.equal(blog.status, 'DRAFT');
  assert.equal(blog.visibility, 'PRIVATE');
  assert.match(blog.slug, /^how-kafka-works-/);
  assert.deepEqual(blog.tags, ['kafka', 'distributed']);
});

test('draft cannot be made public', async () => {
  const r = await api('PATCH', `/blogs/${blog.id}`, { token: alice.accessToken, body: { visibility: 'PUBLIC' } });
  assert.equal(r.status, 400);
});

test('authorization: draft is readable only by its author', async () => {
  assert.equal((await api('GET', `/blogs/${blog.slug}`)).status, 403); // anonymous
  assert.equal((await api('GET', `/blogs/${blog.slug}`, { token: bob.accessToken })).status, 403);
  assert.equal((await api('GET', `/blogs/${blog.slug}`, { token: alice.accessToken })).status, 200);
  assert.equal((await api('GET', '/blogs/does-not-exist-xyz')).status, 404);
});

test('authorization: only the author can edit / publish / delete', async () => {
  assert.equal((await api('PATCH', `/blogs/${blog.id}`, { token: bob.accessToken, body: { title: 'hacked' } })).status, 403);
  assert.equal((await api('POST', `/blogs/${blog.id}/publish`, { token: bob.accessToken })).status, 403);
  assert.equal((await api('DELETE', `/blogs/${blog.id}`, { token: bob.accessToken })).status, 403);
});

test('edit + publish makes it public for everyone', async () => {
  const e = await api('PATCH', `/blogs/${blog.id}`, { token: alice.accessToken, body: { content: 'Kafka is a distributed log. Consumers read offsets from partitions. Brokers replicate data.' } });
  assert.equal(e.status, 200);
  const p = await api('POST', `/blogs/${blog.id}/publish`, { token: alice.accessToken, body: { visibility: 'PUBLIC' } });
  assert.equal(p.data.status, 'PUBLISHED');
  assert.ok(p.data.published_at);
  const anon = await api('GET', `/blogs/${blog.slug}`);
  assert.equal(anon.status, 200);
  assert.match(anon.data.content, /Brokers replicate/);
});

test('cache is invalidated after an edit (no stale content)', async () => {
  await api('GET', `/blogs/${blog.slug}`); // warms the cache
  await api('PATCH', `/blogs/${blog.id}`, { token: alice.accessToken, body: { title: `How Kafka Works v2 ${run}` } });
  const r = await api('GET', `/blogs/${blog.slug}`);
  assert.match(r.data.title, /v2/);
});

test('unpublishing hides it again, even though it was cached', async () => {
  await api('POST', `/blogs/${blog.id}/unpublish`, { token: alice.accessToken });
  assert.equal((await api('GET', `/blogs/${blog.slug}`)).status, 403);
  await api('POST', `/blogs/${blog.id}/publish`, { token: alice.accessToken, body: { visibility: 'PUBLIC' } });
  assert.equal((await api('GET', `/blogs/${blog.slug}`)).status, 200);
});

test('likes: idempotent, counted once, can be removed', async () => {
  await api('POST', `/blogs/${blog.id}/like`, { token: bob.accessToken });
  await api('POST', `/blogs/${blog.id}/like`, { token: bob.accessToken });
  await api('POST', `/blogs/${blog.id}/like`, { token: bob.accessToken });
  let r = await api('GET', `/blogs/${blog.slug}`, { token: bob.accessToken });
  assert.equal(r.data.likes, 1);
  assert.equal(r.data.viewer.liked, true);
  await api('DELETE', `/blogs/${blog.id}/like`, { token: bob.accessToken });
  r = await api('GET', `/blogs/${blog.slug}`, { token: bob.accessToken });
  assert.equal(r.data.likes, 0);
});

test('bookmarks and favorites', async () => {
  await api('POST', `/blogs/${blog.id}/bookmark`, { token: bob.accessToken });
  await api('POST', `/blogs/${blog.id}/favorite`, { token: bob.accessToken });
  const b = await api('GET', '/me/bookmarks', { token: bob.accessToken });
  const f = await api('GET', '/me/favorites', { token: bob.accessToken });
  assert.equal(b.data.items.length, 1);
  assert.equal(f.data.items.length, 1);
});

test('comments with replies, permissions on delete', async () => {
  const c1 = await api('POST', `/blogs/${blog.id}/comments`, { token: bob.accessToken, body: { content: 'Great explanation!' } });
  assert.equal(c1.status, 201);
  const c2 = await api('POST', `/blogs/${blog.id}/comments`, { token: alice.accessToken, body: { content: 'Thanks!', parent_comment_id: c1.data.id } });
  assert.equal(c2.data.parent_comment_id, c1.data.id);
  const list = await api('GET', `/blogs/${blog.id}/comments`);
  assert.equal(list.data.items.length, 2);
  // a stranger cannot delete; a comment's author can
  const carol = await login('carol');
  assert.equal((await api('DELETE', `/comments/${c1.data.id}`, { token: carol.accessToken })).status, 403);
  assert.equal((await api('DELETE', `/comments/${c1.data.id}`, { token: bob.accessToken })).status, 200);
  // replies vanish with their parent
  assert.equal((await api('GET', `/blogs/${blog.id}/comments`)).data.items.length, 0);
});

test('comment rate limit kicks in (max 10/min)', async () => {
  const dave = await login('dave');
  let last;
  for (let i = 0; i < 12; i++) last = await api('POST', `/blogs/${blog.id}/comments`, { token: dave.accessToken, body: { content: `spam ${i}` } });
  assert.equal(last.status, 429);
  assert.ok(last.headers.get('retry-after'));
});

test('notifications are created by the background worker', async () => {
  await new Promise((r) => setTimeout(r, 1200)); // give the worker a moment
  const r = await api('GET', '/notifications', { token: alice.accessToken });
  assert.ok(r.data.items.some((n) => n.type === 'comment'), 'alice should be notified about comments');
  assert.ok(r.data.unread > 0);
  await api('POST', '/notifications/read', { token: alice.accessToken });
  assert.equal((await api('GET', '/notifications', { token: alice.accessToken })).data.unread, 0);
});

test('full-text search finds words inside the blog body', async () => {
  const r = await api('GET', '/search?q=offsets partitions');
  assert.ok(r.data.items.some((b) => b.id === blog.id));
  assert.match(r.data.items.find((b) => b.id === blog.id).snippet, /\[\[/); // highlighted match
  const none = await api('GET', '/search?q=zzzznotfoundzzzz');
  assert.equal(none.data.items.length, 0);
  assert.equal((await api('GET', '/search')).status, 400);
});

test('search never leaks private blogs', async () => {
  const p = await api('POST', '/blogs', { token: alice.accessToken, body: { title: `Secret ${run}`, content: 'flibbertigibbet unique word' } });
  assert.equal((await api('GET', '/search?q=flibbertigibbet')).data.items.length, 0);
  assert.equal((await api('GET', '/search?q=flibbertigibbet', { token: bob.accessToken })).data.items.length, 0);
  assert.equal((await api('GET', '/search?q=flibbertigibbet', { token: alice.accessToken })).data.items.length, 1);
  await api('DELETE', `/blogs/${p.data.id}`, { token: alice.accessToken });
});

test('feeds: latest, trending, following, recommended, related', async () => {
  const latest = await api('GET', '/feed/latest');
  assert.ok(latest.data.items.some((b) => b.id === blog.id));
  const trending = await api('GET', '/feed/trending');
  assert.equal(trending.status, 200);
  // bob follows alice -> her blog shows in his "following" feed
  assert.equal((await api('POST', `/users/${alice.user.username}/follow`, { token: bob.accessToken })).status, 200);
  const following = await api('GET', '/feed/following', { token: bob.accessToken });
  assert.ok(following.data.items.some((b) => b.id === blog.id));
  assert.equal((await api('GET', '/feed/recommended', { token: bob.accessToken })).status, 200);
  assert.equal((await api('GET', `/blogs/${blog.id}/related`)).status, 200);
  assert.equal((await api('GET', '/feed/following')).status, 401);
});

test('collections: create, add, list, delete', async () => {
  const c = await api('POST', '/collections', { token: bob.accessToken, body: { name: 'Backend Engineering' } });
  assert.equal(c.status, 201);
  assert.equal((await api('POST', `/collections/${c.data.id}/blogs/${blog.id}`, { token: bob.accessToken })).status, 200);
  const items = await api('GET', `/collections/${c.data.id}/blogs`);
  assert.equal(items.data.items.length, 1);
  // someone else can't modify my collection
  assert.equal((await api('POST', `/collections/${c.data.id}/blogs/${blog.id}`, { token: alice.accessToken })).status, 403);
  assert.equal((await api('DELETE', `/collections/${c.data.id}`, { token: bob.accessToken })).status, 200);
});

test('profile, stats, dashboard, username change', async () => {
  const p = await api('GET', `/users/${alice.user.username}`);
  assert.equal(p.data.stats.blogs, 1);
  assert.equal(p.data.stats.followers, 1);
  const d = await api('GET', '/me/dashboard', { token: alice.accessToken });
  assert.equal(d.data.viewsByDay.length, 30);
  assert.ok(d.data.topBlogs.length >= 1);
  const newName = `alice_${run}`.replace(/[^a-z0-9_]/g, '');
  const u = await api('PATCH', '/users/me', { token: alice.accessToken, body: { username: newName, bio: 'I write about backends' } });
  assert.equal(u.data.username, newName);
  assert.equal((await api('PATCH', '/users/me', { token: alice.accessToken, body: { username: 'BAD NAME!' } })).status, 400);
  assert.equal((await api('PATCH', '/users/me', { token: bob.accessToken, body: { username: newName } })).status, 409);
});

test('share returns a public link and counts', async () => {
  const s = await api('POST', `/blogs/${blog.id}/share`, { body: { via: 'whatsapp' } });
  assert.match(s.data.url, new RegExp(`/blog/${blog.slug}$`));
});

test('phone OTP login (with wrong-code protection)', async () => {
  const phone = `+9199${String(Date.now()).slice(-8)}`;
  const send = await api('POST', '/auth/phone/send', { body: { phone } });
  assert.equal(send.status, 200);
  assert.equal((await api('POST', '/auth/phone/verify', { body: { phone, otp: '000000' } })).status, 401);
  const ok = await api('POST', '/auth/phone/verify', { body: { phone, otp: send.data.devOtp } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.user.phone, phone);
  // the code can only be used once
  assert.equal((await api('POST', '/auth/phone/verify', { body: { phone, otp: send.data.devOtp } })).status, 401);
  assert.equal((await api('POST', '/auth/phone/send', { body: { phone: '123' } })).status, 400);
});

test('OTP send is rate limited (3 per 10 min per phone)', async () => {
  const phone = `+9188${String(Date.now()).slice(-8)}`;
  const codes = [];
  for (let i = 0; i < 4; i++) codes.push((await api('POST', '/auth/phone/send', { body: { phone } })).status);
  assert.deepEqual(codes, [200, 200, 200, 429]);
});

test('refresh tokens rotate; logout revokes', async () => {
  const u = await login('erin');
  const r1 = await api('POST', '/auth/refresh', { body: { refreshToken: u.refreshToken } });
  assert.equal(r1.status, 200);
  assert.notEqual(r1.data.refreshToken, u.refreshToken);
  assert.equal((await api('POST', '/auth/refresh', { body: { refreshToken: u.refreshToken } })).status, 401); // old one is dead
  await api('POST', '/auth/logout', { body: { refreshToken: r1.data.refreshToken } });
  assert.equal((await api('POST', '/auth/refresh', { body: { refreshToken: r1.data.refreshToken } })).status, 401);
});

test('google login says "not configured" without a client id', async () => {
  const r = await api('POST', '/auth/google', { body: { idToken: 'x'.repeat(20) } });
  assert.ok([501, 401].includes(r.status));
});

function openWs(path, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BASE.replace('http', 'ws')}${path}?token=${token}`);
    const inbox = [];
    ws.on('message', (m) => inbox.push(JSON.parse(m.toString())));
    ws.on('open', () => resolve({ ws, inbox }));
    ws.on('unexpected-response', (req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.on('error', reject);
  });
}
const until = async (fn, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 50)); } return false; };

test('live chat: two users talk in real time, messages are saved', async () => {
  const a = await openWs(`/ws/chat/blog/${blog.id}`, alice.accessToken);
  const b = await openWs(`/ws/chat/blog/${blog.id}`, bob.accessToken);
  await until(() => a.inbox.length && b.inbox.length); // both get "history"
  b.ws.send(JSON.stringify({ message: 'What about offsets?' }));
  assert.ok(await until(() => a.inbox.some((m) => m.type === 'message')), 'alice should receive bob\'s message');
  const got = a.inbox.find((m) => m.type === 'message');
  assert.equal(got.message.message, 'What about offsets?');
  a.ws.close(); b.ws.close();
  // a third person joining later sees history
  const c = await openWs(`/ws/chat/blog/${blog.id}`, alice.accessToken);
  await until(() => c.inbox.length);
  assert.ok(c.inbox[0].messages.some((m) => m.message === 'What about offsets?'));
  c.ws.close();
});

test('chat is blocked without a token or without access to a private blog', async () => {
  await assert.rejects(openWs(`/ws/chat/blog/${blog.id}`, 'bad-token'), /401/);
  const priv = await api('POST', '/blogs', { token: alice.accessToken, body: { title: `Private ${run}`, content: 'x' } });
  await assert.rejects(openWs(`/ws/chat/blog/${priv.data.id}`, bob.accessToken), /403/);
});

test('live notifications arrive over WebSocket', async () => {
  const n = await openWs('/ws/notifications', alice.accessToken);
  await api('POST', `/blogs/${blog.id}/like`, { token: bob.accessToken });
  assert.ok(await until(() => n.inbox.some((m) => m.type === 'notification'), 4000));
  n.ws.close();
});

test('account deletion removes the user and their blogs', async () => {
  const z = await login('zed');
  const b = await api('POST', '/blogs', { token: z.accessToken, body: { title: `Zed ${run}`, content: 'bye' } });
  assert.equal((await api('DELETE', '/users/me', { token: z.accessToken })).status, 200);
  assert.equal((await api('GET', `/users/${z.user.username}`)).status, 404);
  assert.equal((await api('GET', `/blogs/${b.data.slug}`)).status, 404);
  assert.equal((await api('POST', '/auth/refresh', { body: { refreshToken: z.refreshToken } })).status, 401);
});

test('bad input returns clean 400s', async () => {
  assert.equal((await api('POST', '/blogs', { token: alice.accessToken, body: { title: '' } })).status, 400);
  assert.equal((await api('POST', '/blogs', { token: alice.accessToken, body: { title: 'x', category: 'Nope' } })).status, 400);
  assert.equal((await api('GET', '/blogs/abc/comments')).status, 400);
});
