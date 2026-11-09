import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { ZodError } from 'zod';
import { config } from './config.js';
import { pool } from './db.js';
import { HttpError } from './errors.js';
import { pingRedis, rateLimit } from './rateLimit.js';
import authRoutes from './routes/auth.js';
import onboardingRoutes from './routes/onboarding.js';
import accountRoutes from './routes/accounts.js';
import adminRoutes from './routes/admin.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1); // behind Render's proxy: req.ip is the real client
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({ origin: config.corsOrigins, methods: ['GET', 'POST'], allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Bootstrap-Token'] }));
  app.use(express.json({ limit: '10kb' }));

  // Health endpoints are mounted before the rate limiter so monitors are never throttled.
  app.get('/healthz', (req, res) => res.json({ status: 'ok' }));
  app.get('/readyz', async (req, res) => {
    const checks = { database: 'fail', redis: 'fail' };
    try {
      await pool.query('SELECT 1');
      checks.database = 'ok';
    } catch {
      /* stays fail */
    }
    try {
      checks.redis = await pingRedis();
    } catch {
      /* stays fail */
    }
    const ready = checks.database === 'ok' && checks.redis !== 'fail';
    res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready', checks });
  });

  app.use(rateLimit({ name: 'general', windowSec: 60, max: config.generalRateMax }));
  app.use('/api/auth', rateLimit({ name: 'auth', windowSec: 600, max: config.authRateMax }), authRoutes);
  app.use('/api/onboarding', onboardingRoutes);
  app.use('/api/accounts', accountRoutes);
  app.use('/api/admin', adminRoutes);

  app.use((req, res) => res.status(404).json({ error: 'not found' }));

  // Central error handler: clients get a safe message, details stay in the server log.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof ZodError) {
      return res.status(400).json({
        error: 'validation_failed',
        issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid JSON' });
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'payload too large' });
    console.error(err);
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}
