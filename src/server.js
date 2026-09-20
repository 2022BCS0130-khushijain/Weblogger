import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { ZodError } from 'zod';
import { config } from './config.js';
import { pool, query } from './db.js';
import { redis } from './redis.js';
import { runMigrations } from './migrate.js';
import { optionalAuth } from './middleware/auth.js';
import { startWorker } from './worker.js';
import authRoutes from './modules/auth.js';
import userRoutes from './modules/users.js';
import blogRoutes from './modules/blogs.js';
import socialRoutes from './modules/social.js';
import collectionRoutes from './modules/collections.js';
import discoveryRoutes from './modules/discovery.js';
import notificationRoutes from './modules/notifications.js';
import { attachRealtime } from './modules/realtime.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, '..', 'public');

export function buildApp() {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);
  app.use(express.json({ limit: '1mb' }));
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY' });
    next();
  });

  // Every API route lives under /api. optionalAuth reads the token if there is one.
  const api = express.Router();
  api.use(optionalAuth);
  api.get('/health', async (req, res) => {
    try {
      await query('SELECT 1');
      await redis.ping();
      res.json({ ok: true });
    } catch (e) {
      res.status(503).json({ ok: false, error: e.message });
    }
  });
  api.get('/config', (req, res) => res.json({ googleClientId: config.googleClientId, devLogin: !config.isProd }));
  for (const r of [authRoutes, userRoutes, blogRoutes, socialRoutes, collectionRoutes, discoveryRoutes, notificationRoutes]) {
    api.use(r);
  }
  api.use((req, res) => res.status(404).json({ error: 'Not found' }));
  app.use('/api', api);

  // Frontend
  app.use(express.static(publicDir));
  app.get('/blog/:slug', (req, res) => res.sendFile(path.join(publicDir, 'index.html'))); // shareable links

  // One central place that turns errors into JSON responses.
  app.use((err, req, res, next) => {
    if (err instanceof ZodError) {
      return res.status(400).json({ error: 'Invalid input', details: err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`) });
    }
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    if (err.status) return res.status(err.status).json({ error: err.message });
    if (err.code === '23505') return res.status(409).json({ error: 'That value is already taken' });
    if (err.code === '23503') return res.status(400).json({ error: 'Referenced item does not exist' });
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });
  return app;
}

export async function start() {
  await runMigrations();
  const server = http.createServer(buildApp());
  const stopRealtime = attachRealtime(server);
  const stopWorker = config.runWorkerInline ? startWorker() : () => {};

  await new Promise((resolve) => server.listen(config.port, resolve));
  console.log(`✔ Inkwell running at ${config.publicUrl}`);

  const shutdown = async () => {
    console.log('shutting down...');
    stopWorker(); stopRealtime();
    server.close();
    await pool.end(); redis.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  start().catch((e) => { console.error('Failed to start:', e); process.exit(1); });
}
