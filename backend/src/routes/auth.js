import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { pool, withTx } from '../db.js';
import { record } from '../audit.js';
import { config } from '../config.js';
import { HttpError } from '../errors.js';
import { DUMMY_HASH, hashPassword, publicUser, requireAuth, signToken, verifyPassword } from '../auth.js';

export const registerSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254),
    fullName: z.string().trim().min(2).max(100),
    password: z.string().min(12).max(128),
  })
  .strict(); // unknown keys (e.g. "role") are rejected, not silently accepted

const loginSchema = z
  .object({ email: z.string().trim().toLowerCase().email().max(254), password: z.string().min(1).max(128) })
  .strict();

const MAX_FAILED = 5;

const r = Router();

// Self-registration ALWAYS creates an ACCOUNT_HOLDER. The role is never read from the request.
r.post('/register', async (req, res) => {
  const b = registerSchema.parse(req.body);
  const hash = await hashPassword(b.password);
  try {
    const user = await withTx(async (c) => {
      const { rows } = await c.query(
        `INSERT INTO users(email, full_name, password_hash, role)
         VALUES ($1,$2,$3,'ACCOUNT_HOLDER') RETURNING id, email, full_name, role`,
        [b.email, b.fullName, hash],
      );
      await record(c, {
        actorId: rows[0].id,
        actorRole: 'ACCOUNT_HOLDER',
        action: 'USER_REGISTERED',
        target: `user:${rows[0].id}`,
        ip: req.ip,
      });
      return rows[0];
    });
    res.status(201).json({ user: publicUser(user) });
  } catch (e) {
    if (e.code === '23505') throw new HttpError(409, 'email already registered');
    throw e;
  }
});

r.post('/login', async (req, res) => {
  const b = loginSchema.parse(req.body);
  const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [b.email]);
  const u = rows[0];
  const locked = Boolean(u?.locked_until && new Date(u.locked_until) > new Date());
  // Always run scrypt (against a dummy hash if the user is unknown) so timing does not leak existence.
  const passwordOk = await verifyPassword(b.password, u?.password_hash ?? DUMMY_HASH);

  if (!u || !passwordOk || u.status !== 'ACTIVE' || locked) {
    await withTx(async (c) => {
      let action = 'LOGIN_FAILED';
      if (u && !passwordOk && !locked) {
        const upd = await c.query(
          `UPDATE users SET failed_logins = failed_logins + 1,
                  locked_until = CASE WHEN failed_logins + 1 >= $2 THEN now() + interval '15 minutes' ELSE locked_until END
            WHERE id = $1 RETURNING failed_logins`,
          [u.id, MAX_FAILED],
        );
        if (upd.rows[0].failed_logins >= MAX_FAILED) action = 'ACCOUNT_LOCKED';
      } else if (u && (locked || u.status !== 'ACTIVE')) {
        action = locked ? 'LOGIN_BLOCKED_LOCKED' : 'LOGIN_BLOCKED_DISABLED';
      }
      await record(c, {
        actorId: u?.id ?? null,
        actorRole: u?.role ?? null,
        action,
        target: u ? `user:${u.id}` : null,
        details: u ? {} : { emailAttempted: b.email },
        ip: req.ip,
      });
    });
    // One generic message for every failure reason.
    throw new HttpError(401, 'invalid credentials');
  }

  await withTx(async (c) => {
    await c.query('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1', [u.id]);
    await record(c, { actorId: u.id, actorRole: u.role, action: 'LOGIN_SUCCESS', target: `user:${u.id}`, ip: req.ip });
  });
  res.json({ token: signToken(u), user: publicUser(u) });
});

r.post('/logout', requireAuth, async (req, res) => {
  await withTx(async (c) => {
    // Bumping token_version invalidates every token issued so far for this user.
    await c.query('UPDATE users SET token_version = token_version + 1 WHERE id = $1', [req.user.id]);
    await record(c, { actorId: req.user.id, actorRole: req.user.role, action: 'LOGOUT', target: `user:${req.user.id}`, ip: req.ip });
  });
  res.json({ ok: true });
});

r.get('/me', requireAuth, (req, res) => res.json({ user: publicUser(req.user) }));

// One-time creation of the very first administrator (protected by BOOTSTRAP_TOKEN).
// Prefer `npm run create-admin` where you have shell access; this exists for hosts without one.
r.post('/bootstrap-admin', async (req, res) => {
  if (!config.bootstrapToken) throw new HttpError(404, 'not found'); // disabled unless configured
  const digest = (s) => crypto.createHash('sha256').update(s).digest();
  const given = digest(String(req.headers['x-bootstrap-token'] || ''));
  if (!crypto.timingSafeEqual(given, digest(config.bootstrapToken))) {
    await withTx((c) => record(c, { action: 'BOOTSTRAP_DENIED', ip: req.ip }));
    throw new HttpError(403, 'forbidden');
  }
  const b = registerSchema.parse(req.body);
  const hash = await hashPassword(b.password);
  const user = await withTx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(727002)');
    const existing = await c.query("SELECT 1 FROM users WHERE role = 'ADMIN' LIMIT 1");
    if (existing.rowCount) throw new HttpError(409, 'an administrator already exists');
    const { rows } = await c.query(
      `INSERT INTO users(email, full_name, password_hash, role) VALUES ($1,$2,$3,'ADMIN') RETURNING id, email, full_name, role`,
      [b.email, b.fullName, hash],
    );
    await record(c, { actorId: rows[0].id, actorRole: 'ADMIN', action: 'ADMIN_BOOTSTRAPPED', target: `user:${rows[0].id}`, ip: req.ip });
    return rows[0];
  });
  res.status(201).json({ user: publicUser(user) });
});

export default r;
