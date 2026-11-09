function need(key) {
  const v = process.env[key];
  if (!v) throw new Error(`Missing required environment variable ${key}`);
  return v;
}

export const config = {
  port: Number(process.env.PORT || 4000),
  databaseUrl: need('DATABASE_URL'),
  jwtSecret: need('JWT_SECRET'),
  bootstrapToken: process.env.BOOTSTRAP_TOKEN || '',
  redisUrl: process.env.REDIS_URL || '',
  corsOrigins: (process.env.CORS_ORIGIN || 'http://localhost:5173').split(',').map((s) => s.trim()),
  isProd: process.env.NODE_ENV === 'production',
  // Rate limits (requests per window). Overridable so tests are not throttled.
  generalRateMax: Number(process.env.GENERAL_RATE_MAX || 300),
  authRateMax: Number(process.env.AUTH_RATE_MAX || 20),
};

if (config.jwtSecret.length < 32) {
  throw new Error('JWT_SECRET must be at least 32 characters');
}
