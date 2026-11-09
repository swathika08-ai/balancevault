import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { pool, withTx } from '../db.js';
import { record, verifyChain } from '../audit.js';
import { HttpError } from '../errors.js';
import { hashPassword, publicUser, requireAuth, requireRole } from '../auth.js';
import { registerSchema } from './auth.js';

const uuid = z.string().uuid();
const r = Router();
// Server-side gate for EVERY admin route. Holders get 403 no matter what the UI shows.
r.use(requireAuth, requireRole('ADMIN'));

const newAccountNumber = () => 'BV' + Array.from({ length: 12 }, () => crypto.randomInt(10)).join('');

/* ---------- onboarding review ---------- */
r.get('/onboarding', async (req, res) => {
  const status = z.enum(['PENDING', 'APPROVED', 'REJECTED']).default('PENDING').parse(req.query.status);
  const { rows } = await pool.query(
    `SELECT o.id, o.status, o.phone, o.address, o.id_document_ref, o.created_at, o.review_note,
            u.id AS user_id, u.email, u.full_name
       FROM onboarding_applications o JOIN users u ON u.id = o.user_id
      WHERE o.status = $1 ORDER BY o.created_at ASC LIMIT 200`,
    [status],
  );
  res.json({ applications: rows });
});

const decisionSchema = z
  .object({ decision: z.enum(['APPROVE', 'REJECT']), note: z.string().trim().max(300).optional() })
  .strict();

r.post('/onboarding/:id/decision', async (req, res) => {
  const id = uuid.parse(req.params.id);
  const b = decisionSchema.parse(req.body);
  const out = await withTx(async (c) => {
    const { rows } = await c.query('SELECT * FROM onboarding_applications WHERE id = $1 FOR UPDATE', [id]);
    if (!rows[0]) throw new HttpError(404, 'application not found');
    if (rows[0].status !== 'PENDING') throw new HttpError(409, `application already ${rows[0].status.toLowerCase()}`);
    const approve = b.decision === 'APPROVE';
    await c.query(
      'UPDATE onboarding_applications SET status=$2, reviewed_by=$3, reviewed_at=now(), review_note=$4 WHERE id=$1',
      [id, approve ? 'APPROVED' : 'REJECTED', req.user.id, b.note ?? null],
    );
    let accountNumber = null;
    if (approve) {
      accountNumber = newAccountNumber();
      await c.query('INSERT INTO accounts(user_id, account_number) VALUES ($1,$2)', [rows[0].user_id, accountNumber]);
    }
    await record(c, {
      actorId: req.user.id,
      actorRole: req.user.role,
      action: approve ? 'ONBOARDING_APPROVED' : 'ONBOARDING_REJECTED',
      target: `application:${id}`,
      details: { applicantId: rows[0].user_id, accountNumber },
      ip: req.ip,
    });
    return { status: approve ? 'APPROVED' : 'REJECTED', accountNumber };
  });
  res.json(out);
});

/* ---------- user management ---------- */
r.get('/users', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, email, full_name, role, status, created_at FROM users ORDER BY created_at DESC LIMIT 500',
  );
  res.json({ users: rows });
});

r.post('/users', async (req, res) => {
  const b = registerSchema.parse(req.body);
  const hash = await hashPassword(b.password);
  try {
    const user = await withTx(async (c) => {
      const { rows } = await c.query(
        `INSERT INTO users(email, full_name, password_hash, role) VALUES ($1,$2,$3,'ADMIN') RETURNING id, email, full_name, role`,
        [b.email, b.fullName, hash],
      );
      await record(c, {
        actorId: req.user.id,
        actorRole: req.user.role,
        action: 'ADMIN_CREATED',
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

const statusSchema = z.object({ status: z.enum(['ACTIVE', 'DISABLED']) }).strict();

r.post('/users/:id/status', async (req, res) => {
  const id = uuid.parse(req.params.id);
  const b = statusSchema.parse(req.body);
  if (id === req.user.id) throw new HttpError(400, 'you cannot change your own status');
  await withTx(async (c) => {
    // Disabling also bumps token_version so existing tokens die immediately.
    const bump = b.status === 'DISABLED' ? 1 : 0;
    const { rowCount } = await c.query('UPDATE users SET status=$2, token_version = token_version + $3 WHERE id=$1', [
      id,
      b.status,
      bump,
    ]);
    if (!rowCount) throw new HttpError(404, 'user not found');
    await record(c, {
      actorId: req.user.id,
      actorRole: req.user.role,
      action: b.status === 'DISABLED' ? 'USER_DISABLED' : 'USER_ENABLED',
      target: `user:${id}`,
      ip: req.ip,
    });
  });
  res.json({ ok: true });
});

/* ---------- accounts overview ---------- */
r.get('/accounts', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT a.id, a.account_number, a.status, u.email, u.full_name,
            COALESCE((SELECT SUM(CASE direction WHEN 'CREDIT' THEN amount_cents ELSE -amount_cents END)
                        FROM ledger_entries WHERE account_id = a.id), 0)::bigint AS balance_cents
       FROM accounts a JOIN users u ON u.id = a.user_id ORDER BY a.created_at DESC LIMIT 500`,
  );
  res.json({ accounts: rows.map((a) => ({ ...a, balance_cents: Number(a.balance_cents) })) });
});

const freezeSchema = z.object({ frozen: z.boolean() }).strict();
r.post('/accounts/:id/freeze', async (req, res) => {
  const id = uuid.parse(req.params.id);
  const b = freezeSchema.parse(req.body);
  await withTx(async (c) => {
    const { rowCount } = await c.query('UPDATE accounts SET status=$2 WHERE id=$1', [id, b.frozen ? 'FROZEN' : 'ACTIVE']);
    if (!rowCount) throw new HttpError(404, 'account not found');
    await record(c, {
      actorId: req.user.id,
      actorRole: req.user.role,
      action: b.frozen ? 'ACCOUNT_FROZEN' : 'ACCOUNT_UNFROZEN',
      target: `account:${id}`,
      ip: req.ip,
    });
  });
  res.json({ ok: true });
});

/* ---------- audit log (reading it is itself audited) ---------- */
const auditQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  beforeId: z.coerce.number().int().positive().optional(),
});

r.get('/audit', async (req, res) => {
  const q = auditQuery.parse(req.query);
  const { rows } = await pool.query(
    `SELECT id, ts, actor_id, actor_role, action, target, details, ip, hash
       FROM audit_log WHERE ($2::bigint IS NULL OR id < $2) ORDER BY id DESC LIMIT $1`,
    [q.limit, q.beforeId ?? null],
  );
  await withTx((c) =>
    record(c, { actorId: req.user.id, actorRole: req.user.role, action: 'AUDIT_VIEWED', ip: req.ip }),
  );
  res.json({ entries: rows });
});

r.get('/audit/verify', async (req, res) => {
  const result = await verifyChain();
  await withTx((c) =>
    record(c, { actorId: req.user.id, actorRole: req.user.role, action: 'AUDIT_VERIFIED', details: { ok: result.ok }, ip: req.ip }),
  );
  res.json(result);
});

export default r;
