import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { OAuth2Client } from 'google-auth-library';
import { config } from '../config.js';
import { query } from '../db.js';
import { redis } from '../redis.js';
import { HttpError, wrap, sha256, randomToken, slugify } from '../utils.js';
import { signAccess, requireAuth } from '../middleware/auth.js';
import { hit, rateLimit } from '../middleware/rateLimit.js';

const router = Router();
const googleClient = config.googleClientId ? new OAuth2Client(config.googleClientId) : null;

const PUBLIC_USER = 'id, username, display_name, avatar_url, bio, email, phone, created_at';

/** Create an access token (short) + refresh token (long) for a user. */
async function issueTokens(userId) {
  const refreshToken = randomToken();
  await query(
    `INSERT INTO refresh_tokens(user_id, token_hash, expires_at)
     VALUES ($1, $2, now() + make_interval(days => $3))`,
    [userId, sha256(refreshToken), config.refreshTtlDays],
  );
  const user = (await query(`SELECT ${PUBLIC_USER} FROM users WHERE id=$1`, [userId])).rows[0];
  return { accessToken: signAccess(userId), refreshToken, user };
}

async function uniqueUsername(seed) {
  const base = (seed || 'user').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 20) || 'user';
  for (let i = 0; i < 8; i++) {
    const candidate = i === 0 && base.length >= 3 ? base : `${base}${crypto.randomInt(1000, 99999)}`;
    const taken = await query('SELECT 1 FROM users WHERE username=$1', [candidate]);
    if (!taken.rowCount) return candidate;
  }
  return `user${randomToken(5)}`;
}

/* ---------- Google ---------- */
router.post('/auth/google', rateLimit({ name: 'google', limit: 30, windowSec: 600 }), wrap(async (req, res) => {
  if (!googleClient) throw new HttpError(501, 'Google login is not configured (set GOOGLE_CLIENT_ID)');
  const { idToken } = z.object({ idToken: z.string().min(10) }).parse(req.body);

  let p;
  try {
    const ticket = await googleClient.verifyIdToken({ idToken, audience: config.googleClientId });
    p = ticket.getPayload();
  } catch {
    throw new HttpError(401, 'Invalid Google token');
  }
  if (!p?.email || !p.email_verified) throw new HttpError(401, 'Google email not verified');

  let user = (await query('SELECT id FROM users WHERE google_id=$1 OR email=$2', [p.sub, p.email])).rows[0];
  if (user) {
    await query('UPDATE users SET google_id=$1 WHERE id=$2 AND google_id IS NULL', [p.sub, user.id]);
  } else {
    const username = await uniqueUsername(p.email.split('@')[0]);
    user = (await query(
      `INSERT INTO users(google_id, email, username, display_name, avatar_url) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [p.sub, p.email, username, p.name || username, p.picture || null],
    )).rows[0];
  }
  res.json(await issueTokens(user.id));
}));

/* ---------- Phone OTP ---------- */
const phoneSchema = z.string().regex(/^\+?[1-9]\d{7,14}$/, 'Enter a phone number like +919876543210');
const otpKey = (phone) => `otp:code:${phone}`;
const otpTriesKey = (phone) => `otp:tries:${phone}`;

router.post('/auth/phone/send', wrap(async (req, res) => {
  const { phone } = z.object({ phone: phoneSchema }).parse(req.body);

  // Two limits: per phone number (stops spamming one person) and per IP (stops mass abuse).
  const perPhone = await hit(`rl:otp-phone:${phone}`, 3, 600);
  const perIp = await hit(`rl:otp-ip:${req.ip}`, 10, 3600);
  if (!perPhone.allowed || !perIp.allowed) {
    const retry = Math.max(perPhone.retryAfter, perIp.retryAfter);
    res.set('Retry-After', String(retry));
    throw new HttpError(429, `Too many OTP requests. Try again in ${retry}s.`);
  }

  const otp = String(crypto.randomInt(100000, 1000000));
  // Store only a hash of the OTP, valid for 5 minutes.
  await redis.set(otpKey(phone), sha256(`${phone}:${otp}`), 'EX', 300);
  await redis.del(otpTriesKey(phone));

  // TODO: plug in a real SMS provider here (Twilio, MSG91, AWS SNS...).
  console.log(`📱 [SMS stub] OTP for ${phone}: ${otp}`);

  // In development we return the OTP so you can test without an SMS provider.
  res.json({ sent: true, ...(config.isProd ? {} : { devOtp: otp }) });
}));

router.post('/auth/phone/verify', wrap(async (req, res) => {
  const { phone, otp } = z.object({ phone: phoneSchema, otp: z.string().length(6) }).parse(req.body);

  const tries = await redis.incr(otpTriesKey(phone));
  if (tries === 1) await redis.expire(otpTriesKey(phone), 300);
  if (tries > 5) throw new HttpError(429, 'Too many wrong attempts. Request a new OTP.');

  const stored = await redis.get(otpKey(phone));
  const given = sha256(`${phone}:${otp}`);
  const ok = stored && crypto.timingSafeEqual(Buffer.from(stored), Buffer.from(given));
  if (!ok) throw new HttpError(401, 'Wrong or expired OTP');
  await redis.del(otpKey(phone), otpTriesKey(phone)); // one-time use

  let user = (await query('SELECT id FROM users WHERE phone=$1', [phone])).rows[0];
  if (!user) {
    const username = await uniqueUsername('user');
    user = (await query(
      `INSERT INTO users(phone, username, display_name) VALUES ($1,$2,$3) RETURNING id`,
      [phone, username, username],
    )).rows[0];
  }
  res.json(await issueTokens(user.id));
}));

/* ---------- Dev-only login so you can try everything without Google/SMS ---------- */
router.post('/auth/dev-login', wrap(async (req, res) => {
  if (config.isProd) throw new HttpError(404, 'Not found');
  const { email, name } = z.object({ email: z.string().min(3).max(100), name: z.string().max(60).optional() }).parse(req.body);
  let user = (await query('SELECT id FROM users WHERE email=$1', [email])).rows[0];
  if (!user) {
    const username = await uniqueUsername(email.split('@')[0]);
    user = (await query(
      `INSERT INTO users(email, username, display_name) VALUES ($1,$2,$3) RETURNING id`,
      [email, username, name || username],
    )).rows[0];
  }
  res.json(await issueTokens(user.id));
}));

/* ---------- Refresh / logout ---------- */
router.post('/auth/refresh', wrap(async (req, res) => {
  const { refreshToken } = z.object({ refreshToken: z.string().min(10) }).parse(req.body);
  // "Rotation": the old refresh token is deleted the moment it's used, and a new one is issued.
  const row = (await query(
    'DELETE FROM refresh_tokens WHERE token_hash=$1 AND expires_at > now() RETURNING user_id',
    [sha256(refreshToken)],
  )).rows[0];
  if (!row) throw new HttpError(401, 'Invalid or expired refresh token');
  res.json(await issueTokens(row.user_id));
}));

router.post('/auth/logout', wrap(async (req, res) => {
  const { refreshToken } = z.object({ refreshToken: z.string().min(10) }).parse(req.body);
  await query('DELETE FROM refresh_tokens WHERE token_hash=$1', [sha256(refreshToken)]);
  res.json({ ok: true });
}));

router.post('/auth/logout-all', requireAuth, wrap(async (req, res) => {
  await query('DELETE FROM refresh_tokens WHERE user_id=$1', [req.userId]);
  res.json({ ok: true });
}));

export default router;
