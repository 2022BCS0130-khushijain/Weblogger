import dotenv from 'dotenv';
dotenv.config({ quiet: true });

const env = process.env;
const port = Number(env.PORT) || 3000;

export const config = {
  port,
  nodeEnv: env.NODE_ENV || 'development',
  isProd: env.NODE_ENV === 'production',
  publicUrl: env.PUBLIC_URL || `http://localhost:${port}`,
  databaseUrl: env.DATABASE_URL || 'postgres://bloguser:blogpass@localhost:5432/blogdb',
  redisUrl: env.REDIS_URL || 'redis://localhost:6379',
  jwtSecret: env.JWT_SECRET || 'dev-secret-change-me',
  accessTtlSec: 15 * 60,      // access token lives 15 minutes
  refreshTtlDays: 30,         // refresh token lives 30 days
  googleClientId: env.GOOGLE_CLIENT_ID || '',
  runWorkerInline: env.RUN_WORKER_INLINE !== 'false',
  trustProxy: env.TRUST_PROXY === 'true',
};

if (config.isProd && config.jwtSecret === 'dev-secret-change-me') {
  throw new Error('Set a real JWT_SECRET in production!');
}
