/* Inkwell frontend — plain JavaScript, no build step.
 * It only talks to the backend through /api/... and two WebSockets. All permission checks happen on the server. */
'use strict';

/* ---------------- tiny helpers ---------------- */
const $ = (s, el = document) => el.querySelector(s);
const app = $('#app');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const initial = (u) => esc((u || '?').trim().charAt(0).toUpperCase());

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('show'), 2600);
}

/* Very small, SAFE markdown renderer: everything is HTML-escaped FIRST, then a few patterns are turned into tags. */
function inline(t) {
  return esc(t)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer nofollow">$1</a>');
}
function md(src) {
  const codes = [];
  const s = String(src).replace(/\r/g, '').replace(/```[^\n]*\n([\s\S]*?)```/g, (m, c) => { codes.push(c); return `\n\n@@CODE${codes.length - 1}@@\n\n`; });
  return s.split(/\n{2,}/).map((raw) => {
    const b = raw.trim();
    if (!b) return '';
    const code = b.match(/^@@CODE(\d+)@@$/);
    if (code) return `<pre><code>${esc(codes[code[1]])}</code></pre>`;
    const h = b.match(/^(#{1,3})\s+(.*)$/);
    if (h && !b.includes('\n')) { const n = h[1].length + 1; return `<h${n}>${inline(h[2])}</h${n}>`; }
    if (/^[-*] /.test(b)) return '<ul>' + b.split('\n').map((l) => `<li>${inline(l.replace(/^[-*]\s+/, ''))}</li>`).join('') + '</ul>';
    if (/^>/.test(b)) return `<blockquote>${inline(b.replace(/^>\s?/gm, ''))}</blockquote>`;
    return `<p>${inline(b).replace(/\n/g, '<br>')}</p>`;
  }).join('\n');
}

/* ---------------- session + API ---------------- */
const state = { user: null, access: localStorage.getItem('access'), refresh: localStorage.getItem('refresh'), cfg: {}, unread: 0, cleanup: null, notifWs: null };

function setSession(s) {
  state.access = s.accessToken; state.refresh = s.refreshToken; state.user = s.user;
  localStorage.setItem('access', s.accessToken); localStorage.setItem('refresh', s.refreshToken);
}
function clearSession() {
  state.access = state.refresh = state.user = null; state.unread = 0;
  localStorage.removeItem('access'); localStorage.removeItem('refresh');
  state.notifWs?.close(); state.notifWs = null;
}

let refreshing = null;
async function refreshTokens() {
  if (!state.refresh) return false;
  refreshing ??= fetch('/api/auth/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken: state.refresh }) })
    .then(async (r) => { if (!r.ok) throw new Error('refresh failed'); setSession(await r.json()); return true; })
    .catch(() => { clearSession(); return false; })
    .finally(() => { refreshing = null; });
  return refreshing;
}

async function api(method, path, body, retry = true) {
  const res = await fetch('/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(state.access ? { Authorization: 'Bearer ' + state.access } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401 && retry && state.refresh && (await refreshTokens())) return api(method, path, body, false);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.details?.join(', ') || data.error || 'Something went wrong'); e.status = res.status; throw e; }
  return data;
}

function wsUrl(path) { return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${path}?token=${encodeURIComponent(state.access)}`; }

/* ---------------- header ---------------- */
function renderNav() {
  const u = state.user;
  $('#nav').innerHTML = u
    ? `<a class="cta" href="#/write">✎ Write</a>
       <a href="#/saved">Saved</a>
       <a href="#/dashboard">Dashboard</a>
       <a href="#/notifications">🔔${state.unread ? `<span class="badge">${state.unread}</span>` : ''}</a>
       <a href="#/u/${esc(u.username)}">@${esc(u.username)}</a>
       <button data-act="logout">Log out</button>`
    : `<a class="cta" href="#/login">Log in</a>`;
}

function connectNotifications() {
  if (!state.access || state.notifWs) return;
  const ws = new WebSocket(wsUrl('/ws/notifications'));
  state.notifWs = ws;
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type !== 'notification') return;
    state.unread++; renderNav();
    toast('🔔 ' + notifText(m.notification));
  };
  ws.onclose = () => { if (state.notifWs === ws) state.notifWs = null; };
}
const notifText = (n) => ({
  like: `${n.actor_name} liked "${n.blog_title}"`,
  comment: `${n.actor_name} commented on "${n.blog_title}"`,
  reply: `${n.actor_name} replied to your comment`,
  follow: `${n.actor_name} started following you`,
}[n.type]);

async function boot() {
  state.cfg = await fetch('/api/config').then((r) => r.json()).catch(() => ({}));
  if (state.access || state.refresh) {
    try { state.user = await api('GET', '/users/me'); connectNotifications();
      api('GET', '/notifications?limit=1').then((d) => { state.unread = d.unread; renderNav(); }).catch(() => {});
    } catch { clearSession(); }
  }
  renderNav();
  // Shareable links look like /blog/<slug>; the app itself uses #/ routes.
  const m = location.pathname.match(/^\/blog\/([^/]+)/);
  if (m) history.replaceState(null, '', `/#/blog/${m[1]}`);
  route();
}

/* ---------------- router ---------------- */
const routes = [
  [/^\/?$/, () => viewFeed('latest')],
  [/^\/feed\/(\w+)$/, (m) => viewFeed(m[1])],
  [/^\/search\/(.*)$/, (m) => viewSearch(decodeURIComponent(m[1]))],
  [/^\/blog\/([^/]+)$/, (m) => viewBlog(m[1])],
  [/^\/write$/, () => viewEditor(null)],
  [/^\/edit\/([^/]+)$/, (m) => viewEditor(m[1])],
  [/^\/u\/([^/]+)$/, (m) => viewProfile(m[1])],
  [/^\/collection\/(\d+)$/, (m) => viewCollection(m[1])],
  [/^\/dashboard$/, viewDashboard],
  [/^\/saved(?:\/(\w+))?$/, (m) => viewSaved(m[1] || 'bookmarks')],
  [/^\/notifications$/, viewNotifications],
  [/^\/login$/, viewLogin],
];

async function route() {
  state.cleanup?.(); state.cleanup = null;
  const path = location.hash.slice(1) || '/';
  for (const [re, fn] of routes) {
    const m = path.match(re);
    if (!m) continue;
    app.innerHTML = '<p class="empty">Loading…</p>';
    try { await fn(m); } catch (e) {
      if (e.status === 401) { app.innerHTML = `<p class="empty">Please <a href="#/login">log in</a> to see this.</p>`; }
      else if (e.status === 403) app.innerHTML = `<p class="empty">🔒 You don't have access to this page.</p>`;
      else if (e.status === 404) app.innerHTML = `<p class="empty">Not found.</p>`;
      else app.innerHTML = `<p class="empty err">${esc(e.message)}</p>`;
    }
    window.scrollTo(0, 0);
    return;
  }
  app.innerHTML = '<p class="empty">Page not found.</p>';
}
window.addEventListener('hashchange', route);

/* ---------------- views ---------------- */
function postCard(b, { snippet } = {}) {
  const status = b.status === 'DRAFT' ? '<span class="pill warn">Draft</span>' : b.visibility === 'PRIVATE' ? '<span class="pill grey">Private</span>' : '';
  const body = snippet ? `<p class="excerpt snippet">${esc(snippet).replace(/\[\[/g, '<mark>').replace(/\]\]/g, '</mark>')}…</p>`
    : `<p class="excerpt">${esc(b.excerpt.replace(/[#*`>]/g, ''))}${b.excerpt.length >= 240 ? '…' : ''}</p>`;
  return `<div class="post">
    <h3><a href="#/blog/${esc(b.slug)}">${esc(b.title)}</a></h3>
    <div class="meta"><a href="#/u/${esc(b.author_username)}">${esc(b.author_name)}</a><span>${fmtDate(b.published_at || b.updated_at)}</span>
      ${b.category ? `<span class="pill">${esc(b.category)}</span>` : ''}${status}
      <span>♥ ${b.likes}</span><span>💬 ${b.comments}</span><span>👁 ${b.view_count}</span></div>
    ${body}</div>`;
}
const list = (items, opts) => (items.length ? items.map((b) => postCard(b, opts)).join('') : '<p class="empty">Nothing here yet.</p>');

async function viewFeed(tab) {
  const tabs = [['latest', 'Latest'], ['trending', 'Trending'], ['following', 'Following'], ['recommended', 'For you']];
  const head = `<div class="tabs">${tabs.map(([k, l]) => `<a class="${k === tab ? 'on' : ''}" href="#/feed/${k}">${l}</a>`).join('')}</div>`;
  if ((tab === 'following' || tab === 'recommended') && !state.user) { app.innerHTML = head + '<p class="empty">Log in to see this feed.</p>'; return; }
  const d = await api('GET', `/feed/${tab}`);
  app.innerHTML = head + list(d.items);
}

async function viewSearch(q) {
  const d = await api('GET', '/search?q=' + encodeURIComponent(q));
  app.innerHTML = `<h2>Results for “${esc(q)}”</h2>` + (d.items.length ? d.items.map((b) => postCard(b, { snippet: b.snippet })).join('') : '<p class="empty">No blog contains those words.</p>');
}

/* ----- single blog ----- */
function commentTree(items) {
  const byParent = {};
  items.forEach((c) => (byParent[c.parent_comment_id ?? 0] ||= []).push(c));
  const draw = (pid) => (byParent[pid] || []).map((c) => `
    <div class="comment" data-cid="${c.id}">
      <span class="who">${esc(c.display_name)}</span> <span class="hint">@${esc(c.username)} · ${fmtDate(c.created_at)}</span>
      <p>${esc(c.content)}</p>
      <div class="row">${state.user ? `<button class="btn small" data-act="reply" data-id="${c.id}">Reply</button>` : ''}
        ${state.user && (state.user.id === c.user_id || state.blog?.viewer.isAuthor) ? `<button class="btn small danger" data-act="delcomment" data-id="${c.id}">Delete</button>` : ''}</div>
      <div class="reply-slot"></div>${draw(c.id)}
    </div>`).join('');
  return draw(0) || '<p class="hint">No comments yet. Start the conversation.</p>';
}

async function viewBlog(slug) {
  const b = await api('GET', `/blogs/${encodeURIComponent(slug)}`);
  state.blog = b;
  document.title = b.title + ' · Inkwell';
  const [cm, rel] = await Promise.all([api('GET', `/blogs/${b.id}/comments`), api('GET', `/blogs/${b.id}/related`).catch(() => ({ items: [] }))]);
  const v = b.viewer;
  const authorBar = v.isAuthor ? `
    <div class="banner"><div class="row"><b>${b.status === 'DRAFT' ? 'Draft — only you can see this.' : b.visibility === 'PRIVATE' ? 'Published privately — only you can see this.' : 'Published — visible to everyone.'}</b>
      <span style="flex:1"></span>
      <a class="btn small" href="#/edit/${esc(b.slug)}">Edit</a>
      ${b.status === 'DRAFT' ? `<button class="btn small primary" data-act="publish" data-vis="PUBLIC">Publish</button>`
        : `<button class="btn small" data-act="unpublish">Unpublish</button>`}
      <button class="btn small danger" data-act="delblog">Delete</button></div></div>` : '';

  app.innerHTML = `
  <article class="blog">
    ${authorBar}
    <div class="meta">${b.category ? `<span class="pill">${esc(b.category)}</span>` : ''}${b.tags.map((t) => `<span class="pill grey">#${esc(t)}</span>`).join('')}</div>
    <h1>${esc(b.title)}</h1>
    <div class="meta"><a href="#/u/${esc(b.author_username)}"><b>${esc(b.author_name)}</b></a><span>${fmtDate(b.published_at || b.created_at)}</span><span>👁 ${b.view_count}</span><span>↗ ${b.share_count} shares</span></div>
    <div class="prose">${md(b.content)}</div>
    <div class="actions row">
      <button class="btn ${v.liked ? 'on' : ''}" data-act="toggle" data-what="like">♥ ${v.liked ? 'Liked' : 'Like'} · ${b.likes}</button>
      <button class="btn ${v.bookmarked ? 'on' : ''}" data-act="toggle" data-what="bookmark">🔖 ${v.bookmarked ? 'Saved' : 'Read later'}</button>
      <button class="btn ${v.favorited ? 'on' : ''}" data-act="toggle" data-what="favorite">★ Favorite</button>
      ${b.visibility === 'PUBLIC' ? `<button class="btn" data-act="share">↗ Share</button>` : ''}
      ${state.user ? `<button class="btn" data-act="addcol">＋ Collection</button>` : ''}
    </div>
    <div id="colBox"></div>
  </article>

  <section class="panel"><h3>Live discussion</h3><div id="chat"></div></section>

  <section class="panel"><h3>Comments (${cm.items.length})</h3>
    ${state.user ? `<div class="row" style="align-items:flex-start"><textarea id="newComment" rows="2" placeholder="Write a comment…" maxlength="2000" style="flex:1"></textarea><button class="btn primary" data-act="comment">Post</button></div>` : '<p class="hint"><a href="#/login">Log in</a> to comment.</p>'}
    <div id="comments">${commentTree(cm.items)}</div></section>

  ${rel.items.length ? `<h3 style="margin-top:26px">Related blogs</h3>${rel.items.map((x) => postCard(x)).join('')}` : ''}`;

  setupChat(b);
}

function setupChat(b) {
  const box = $('#chat');
  if (!state.user) { box.innerHTML = '<p class="hint"><a href="#/login">Log in</a> to join the live chat.</p>'; return; }
  box.innerHTML = `<div class="chat-log" id="chatLog"><div class="sys">Connecting…</div></div>
    <div class="row"><input id="chatInput" placeholder="Say something to everyone reading right now…" maxlength="500" style="flex:1"><button class="btn primary" data-act="chatsend">Send</button></div>`;
  const log = $('#chatLog');
  const line = (m) => { log.insertAdjacentHTML('beforeend', `<div><b>${esc(m.display_name)}</b>: ${esc(m.message)}</div>`); log.scrollTop = log.scrollHeight; };
  const ws = new WebSocket(wsUrl(`/ws/chat/blog/${b.id}`));
  state.chatWs = ws;
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === 'history') { log.innerHTML = m.messages.length ? '' : '<div class="sys">No messages yet. Say hi!</div>'; m.messages.forEach(line); }
    else if (m.type === 'message') { if ($('.sys', log)) log.innerHTML = ''; line(m.message); }
    else if (m.type === 'error') toast(m.error);
  };
  ws.onclose = () => log.insertAdjacentHTML('beforeend', '<div class="sys">Disconnected. Refresh to reconnect.</div>');
  state.cleanup = () => { ws.onclose = null; ws.close(); state.chatWs = null; document.title = 'Inkwell'; };
}

/* ----- editor ----- */
async function viewEditor(slug) {
  if (!state.user) throw Object.assign(new Error('login'), { status: 401 });
  const cats = (await api('GET', '/categories')).items;
  const b = slug ? await api('GET', `/blogs/${encodeURIComponent(slug)}`) : null;
  if (b && !b.viewer.isAuthor) throw Object.assign(new Error('no'), { status: 403 });
  const published = b?.status === 'PUBLISHED';
  app.innerHTML = `
  <h2>${b ? 'Edit blog' : 'New blog'}</h2>
  <label>Title</label><input id="edTitle" maxlength="200" value="${esc(b?.title || '')}">
  <div class="row"><div style="flex:1;min-width:180px"><label>Category</label>
    <select id="edCat"><option value="">— none —</option>${cats.map((c) => `<option ${b?.category === c.name ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
    <div style="flex:2;min-width:220px"><label>Tags (comma separated)</label><input id="edTags" value="${esc((b?.tags || []).join(', '))}" placeholder="kafka, redis, backend"></div></div>
  <label>Content <span class="hint">(supports # headings, **bold**, *italic*, \`code\`, - lists, &gt; quotes, \`\`\` code blocks)</span></label>
  <textarea class="editor" id="edContent">${esc(b?.content || '')}</textarea>
  <div class="row" style="margin-top:14px">
    <button class="btn" data-act="save">${published ? 'Save changes' : 'Save draft'}</button>
    ${published
      ? `<select id="edVis" style="width:auto"><option value="PUBLIC" ${b.visibility === 'PUBLIC' ? 'selected' : ''}>Public</option><option value="PRIVATE" ${b.visibility === 'PRIVATE' ? 'selected' : ''}>Private</option></select>`
      : `<button class="btn primary" data-act="publish-editor" data-vis="PUBLIC">Publish publicly</button><button class="btn" data-act="publish-editor" data-vis="PRIVATE">Publish privately</button>`}
  </div>
  <p class="hint">Drafts are always private. Nothing is public until you publish.</p><p class="err" id="edErr"></p>`;
  app.dataset.blogId = b?.id || '';
  app.dataset.slug = b?.slug || '';
}

async function saveEditor() {
  const tags = $('#edTags').value.split(',').map((t) => t.trim()).filter(Boolean);
  const data = { title: $('#edTitle').value, content: $('#edContent').value, category: $('#edCat').value || null, tags };
  const vis = $('#edVis');
  if (vis) data.visibility = vis.value;
  const id = app.dataset.blogId;
  const b = id ? await api('PATCH', `/blogs/${id}`, data) : await api('POST', '/blogs', data);
  app.dataset.blogId = b.id; app.dataset.slug = b.slug;
  return b;
}

/* ----- profile / collections ----- */
async function viewProfile(username) {
  const [p, blogs, cols] = await Promise.all([api('GET', `/users/${username}`), api('GET', `/users/${username}/blogs`), api('GET', `/users/${username}/collections`)]);
  const s = p.stats, me = p.viewer.isMe;
  const groups = {};
  blogs.items.forEach((b) => (groups[b.category || 'Uncategorized'] ||= []).push(b));
  app.innerHTML = `
  <div class="row" style="gap:18px;align-items:center">
    <div class="avatar">${p.avatar_url ? `<img src="${esc(p.avatar_url)}" alt="">` : initial(p.display_name)}</div>
    <div style="flex:1"><h2 style="margin:0">${esc(p.display_name)}</h2><div class="hint">@${esc(p.username)} · joined ${fmtDate(p.created_at)}</div><p style="margin:6px 0 0">${esc(p.bio)}</p></div>
    ${me ? '<button class="btn" data-act="editprofile">Edit profile</button>' : state.user ? `<button class="btn ${p.viewer.following ? 'on' : 'primary'}" data-act="follow" data-user="${esc(p.username)}" data-on="${p.viewer.following}">${p.viewer.following ? 'Following' : 'Follow'}</button>` : ''}
  </div>
  <div id="profileForm"></div>
  <div class="stats"><div><b>${s.blogs}</b><span>Blogs</span></div><div><b>${s.views}</b><span>Views</span></div><div><b>${s.likes}</b><span>Likes received</span></div>
    <div><b>${s.comments}</b><span>Comments</span></div><div><b>${s.followers}</b><span>Followers</span></div><div><b>${s.following}</b><span>Following</span></div></div>

  <h3>Collections</h3>
  <div class="grid2">${cols.items.map((c) => `<a class="tile" href="#/collection/${c.id}"><b>${esc(c.name)}</b><div class="hint">${c.blog_count} blogs</div></a>`).join('') || '<p class="hint">No collections yet.</p>'}
  </div>
  ${me ? `<div class="row" style="margin-top:10px"><input id="newColName" placeholder="New collection name" style="max-width:260px"><button class="btn" data-act="newcol">Create</button></div>` : ''}

  <h3 style="margin-top:26px">Blogs</h3>
  ${Object.keys(groups).length ? Object.entries(groups).map(([cat, arr]) => `<div class="group-title">${esc(cat)}</div>` + arr.map((b) =>
    `<div class="item-line"><a href="#/blog/${esc(b.slug)}">${esc(b.title)}</a><span class="hint">${b.status === 'DRAFT' ? 'Draft' : b.visibility === 'PRIVATE' ? 'Private' : fmtDate(b.published_at)}</span></div>`).join('')).join('') : '<p class="empty">No blogs yet.</p>'}`;
  app.dataset.username = p.username;
  app.dataset.profile = JSON.stringify({ display_name: p.display_name, bio: p.bio, username: p.username });
}

async function viewCollection(id) {
  const d = await api('GET', `/collections/${id}/blogs`);
  app.innerHTML = `<h2>${esc(d.collection.name)}</h2><p class="hint">${esc(d.collection.description)}</p>${list(d.items)}`;
}

async function viewDashboard() {
  if (!state.user) throw Object.assign(new Error('login'), { status: 401 });
  const d = await api('GET', '/me/dashboard');
  const t = d.totals, max = Math.max(1, ...d.viewsByDay.map((x) => x.views));
  app.innerHTML = `<h2>My dashboard</h2>
  <div class="stats"><div><b>${t.views}</b><span>Views</span></div><div><b>${t.likes}</b><span>Likes</span></div><div><b>${t.comments}</b><span>Comments</span></div><div><b>${t.blogs}</b><span>Blogs</span></div><div><b>${t.followers}</b><span>Followers</span></div></div>
  <section class="panel"><h3>Views — last 30 days</h3><div class="bars">${d.viewsByDay.map((x) => `<i title="${x.day}: ${x.views}" style="height:${Math.round((x.views / max) * 100)}%"></i>`).join('')}</div></section>
  <h3 style="margin-top:22px">Top blogs</h3>${list(d.topBlogs)}`;
}

async function viewSaved(kind) {
  const d = await api('GET', `/me/${kind}`);
  app.innerHTML = `<div class="tabs"><a class="${kind === 'bookmarks' ? 'on' : ''}" href="#/saved/bookmarks">Read later</a><a class="${kind === 'favorites' ? 'on' : ''}" href="#/saved/favorites">Favorites</a></div>${list(d.items)}`;
}

async function viewNotifications() {
  const d = await api('GET', '/notifications');
  app.innerHTML = `<div class="row"><h2 style="flex:1">Notifications</h2><button class="btn" data-act="readall">Mark all read</button></div>` +
    (d.items.length ? d.items.map((n) => `<div class="notif ${n.is_read ? '' : 'unread'}"><a href="#/${n.blog_slug ? 'blog/' + esc(n.blog_slug) : 'u/' + esc(n.actor_username)}">${esc(notifText(n))}</a> <span class="hint">${fmtDate(n.created_at)}</span></div>`).join('') : '<p class="empty">Nothing yet.</p>');
}

/* ----- login ----- */
async function viewLogin() {
  app.innerHTML = `<div class="narrow">
    <h2>Log in to Inkwell</h2>
    <div id="googleBox"></div>
    <section class="panel"><h3>Phone (OTP)</h3>
      <input id="phone" placeholder="+919876543210" inputmode="tel">
      <div id="otpBox" style="display:none"><label>6-digit code</label><input id="otp" maxlength="6" inputmode="numeric"></div>
      <div class="row" style="margin-top:10px"><button class="btn primary" data-act="sendotp">Send code</button><button class="btn" id="verifyBtn" data-act="verifyotp" style="display:none">Verify</button></div>
      <p class="hint" id="otpHint"></p></section>
    ${state.cfg.devLogin ? `<section class="panel"><h3>Developer login</h3><p class="hint">Only exists in development mode. Type any email to get an account instantly.</p>
      <input id="devEmail" placeholder="you@example.com"><div class="row" style="margin-top:10px"><input id="devName" placeholder="Display name (optional)" style="flex:1"><button class="btn primary" data-act="devlogin">Continue</button></div></section>` : ''}
    <p class="err" id="loginErr"></p></div>`;

  if (state.cfg.googleClientId) {
    await new Promise((res) => { const s = document.createElement('script'); s.src = 'https://accounts.google.com/gsi/client'; s.onload = res; s.onerror = res; document.head.appendChild(s); });
    if (window.google) {
      google.accounts.id.initialize({ client_id: state.cfg.googleClientId, callback: (r) => finishLogin(api('POST', '/auth/google', { idToken: r.credential })) });
      google.accounts.id.renderButton($('#googleBox'), { theme: 'outline', size: 'large', width: 300 });
    }
  }
}
async function finishLogin(promise) {
  try {
    setSession(await promise);
    connectNotifications(); renderNav();
    toast('Welcome, ' + state.user.display_name);
    location.hash = '#/';
  } catch (e) { const el = $('#loginErr'); if (el) el.textContent = e.message; }
}

/* ---------------- click handling (one listener for the whole page) ---------------- */
const actions = {
  logout: async () => { try { await api('POST', '/auth/logout', { refreshToken: state.refresh }); } catch {} clearSession(); renderNav(); location.hash = '#/'; toast('Logged out'); },
  devlogin: () => finishLogin(api('POST', '/auth/dev-login', { email: $('#devEmail').value.trim(), name: $('#devName').value.trim() || undefined })),
  sendotp: async () => {
    try {
      const r = await api('POST', '/auth/phone/send', { phone: $('#phone').value.trim() });
      $('#otpBox').style.display = ''; $('#verifyBtn').style.display = '';
      $('#otpHint').textContent = r.devOtp ? `Dev mode: your code is ${r.devOtp}` : 'Code sent by SMS.';
    } catch (e) { $('#loginErr').textContent = e.message; }
  },
  verifyotp: () => finishLogin(api('POST', '/auth/phone/verify', { phone: $('#phone').value.trim(), otp: $('#otp').value.trim() })),

  toggle: async (el) => {
    const what = el.dataset.what, b = state.blog;
    if (!state.user) return (location.hash = '#/login');
    const on = { like: b.viewer.liked, bookmark: b.viewer.bookmarked, favorite: b.viewer.favorited }[what];
    await api(on ? 'DELETE' : 'POST', `/blogs/${b.id}/${what}`);
    route();
  },
  share: async () => {
    const r = await api('POST', `/blogs/${state.blog.id}/share`, { via: 'link' });
    try { await navigator.clipboard.writeText(r.url); toast('Link copied: ' + r.url); } catch { prompt('Copy this link:', r.url); }
  },
  addcol: async () => {
    const cols = (await api('GET', '/collections')).items;
    $('#colBox').innerHTML = cols.length
      ? `<div class="row" style="margin-top:10px">${cols.map((c) => `<button class="btn small" data-act="putcol" data-id="${c.id}">${esc(c.name)}</button>`).join('')}</div>`
      : '<p class="hint">Create a collection from your profile first.</p>';
  },
  putcol: async (el) => { await api('POST', `/collections/${el.dataset.id}/blogs/${state.blog.id}`); $('#colBox').innerHTML = ''; toast('Added to collection'); },

  comment: async () => {
    const t = $('#newComment'); if (!t.value.trim()) return;
    await api('POST', `/blogs/${state.blog.id}/comments`, { content: t.value }); route();
  },
  reply: (el) => {
    const slot = $('.reply-slot', el.closest('.comment'));
    slot.innerHTML = `<div class="row" style="margin:6px 0"><input class="replyText" placeholder="Write a reply…" style="flex:1"><button class="btn small primary" data-act="sendreply" data-id="${el.dataset.id}">Send</button></div>`;
    $('.replyText', slot).focus();
  },
  sendreply: async (el) => {
    const t = $('.replyText', el.closest('.reply-slot')); if (!t.value.trim()) return;
    await api('POST', `/blogs/${state.blog.id}/comments`, { content: t.value, parent_comment_id: Number(el.dataset.id) }); route();
  },
  delcomment: async (el) => { await api('DELETE', `/comments/${el.dataset.id}`); route(); },
  chatsend: () => { const i = $('#chatInput'); if (i.value.trim() && state.chatWs?.readyState === 1) { state.chatWs.send(JSON.stringify({ message: i.value })); i.value = ''; } },

  publish: async (el) => { await api('POST', `/blogs/${state.blog.id}/publish`, { visibility: el.dataset.vis }); toast('Published 🎉'); route(); },
  unpublish: async () => { await api('POST', `/blogs/${state.blog.id}/unpublish`); toast('Moved back to drafts'); route(); },
  delblog: async () => { if (confirm('Delete this blog forever?')) { await api('DELETE', `/blogs/${state.blog.id}`); location.hash = '#/'; toast('Deleted'); } },

  save: async () => { try { const b = await saveEditor(); toast('Saved'); history.replaceState(null, '', `#/edit/${b.slug}`); } catch (e) { $('#edErr').textContent = e.message; } },
  'publish-editor': async (el) => {
    try {
      const b = await saveEditor();
      await api('POST', `/blogs/${b.id}/publish`, { visibility: el.dataset.vis });
      toast('Published 🎉'); location.hash = `#/blog/${b.slug}`;
    } catch (e) { $('#edErr').textContent = e.message; }
  },

  follow: async (el) => { await api(el.dataset.on === 'true' ? 'DELETE' : 'POST', `/users/${el.dataset.user}/follow`); route(); },
  newcol: async () => { const n = $('#newColName').value.trim(); if (n) { await api('POST', '/collections', { name: n }); route(); } },
  editprofile: () => {
    const p = JSON.parse(app.dataset.profile);
    $('#profileForm').innerHTML = `<section class="panel"><label>Display name</label><input id="pfName" value="${esc(p.display_name)}"><label>Username</label><input id="pfUser" value="${esc(p.username)}"><label>Bio</label><textarea id="pfBio" rows="2" maxlength="300">${esc(p.bio)}</textarea>
      <div class="row" style="margin-top:10px"><button class="btn primary" data-act="saveprofile">Save</button></div><p class="err" id="pfErr"></p></section>`;
  },
  saveprofile: async () => {
    try {
      const u = await api('PATCH', '/users/me', { display_name: $('#pfName').value, username: $('#pfUser').value, bio: $('#pfBio').value });
      state.user = { ...state.user, ...u }; renderNav(); location.hash = `#/u/${u.username}`; route();
    } catch (e) { $('#pfErr').textContent = e.message; }
  },
  readall: async () => { await api('POST', '/notifications/read'); state.unread = 0; renderNav(); route(); },
};

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || !actions[el.dataset.act]) return;
  e.preventDefault();
  try { await actions[el.dataset.act](el); } catch (err) { toast(err.message); }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.id === 'chatInput') actions.chatsend(); });
$('#searchForm').addEventListener('submit', (e) => { e.preventDefault(); const q = $('#searchInput').value.trim(); if (q) location.hash = '#/search/' + encodeURIComponent(q); });

boot();
