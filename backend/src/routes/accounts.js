import { Router } from 'express';
import { z } from 'zod';
import { pool, withTx } from '../db.js';
import { requireAuth, requireRole } from '../auth.js';
import { HttpError } from '../errors.js';
import { getBalance, moveMoney } from '../money.js';

const MAX_CENTS = 100_000_000; // 1,000,000.00 per operation

const amount = z.number().int().positive().max(MAX_CENTS);
const memo = z.string().trim().max(140).optional();
const depositSchema = z.object({ amountCents: amount, memo }).strict();
const withdrawSchema = depositSchema;
const transferSchema = z
  .object({ toAccountNumber: z.string().trim().regex(/^BV[0-9]{12}$/), amountCents: amount, memo })
  .strict();
const idemSchema = z.string().min(8).max(100);

const r = Router();
// Every route is "me": the account is looked up by req.user.id, never by an id from the client.
r.use(requireAuth, requireRole('ACCOUNT_HOLDER'));

r.get('/me', async (req, res) => {
  const { rows } = await pool.query('SELECT id, account_number, status, created_at FROM accounts WHERE user_id = $1', [
    req.user.id,
  ]);
  if (!rows[0]) return res.json({ account: null });
  const balanceCents = await getBalance(pool, rows[0].id);
  res.json({
    account: { accountNumber: rows[0].account_number, status: rows[0].status, balanceCents, createdAt: rows[0].created_at },
  });
});

r.get('/me/transactions', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT e.id, e.transfer_id, e.direction, e.amount_cents, e.kind, e.memo, e.created_at
       FROM ledger_entries e JOIN accounts a ON a.id = e.account_id
      WHERE a.user_id = $1 ORDER BY e.id DESC LIMIT 100`,
    [req.user.id],
  );
  res.json({
    transactions: rows.map((t) => ({
      id: t.id,
      transferId: t.transfer_id,
      direction: t.direction,
      amountCents: Number(t.amount_cents),
      kind: t.kind,
      memo: t.memo,
      createdAt: t.created_at,
    })),
  });
});

function handler(kind, schema) {
  return async (req, res) => {
    const body = schema.parse(req.body);
    const header = req.headers['idempotency-key'];
    if (!header) throw new HttpError(400, 'Idempotency-Key header is required');
    const idemKey = idemSchema.parse(header);
    const result = await withTx((c) =>
      moveMoney(c, {
        user: req.user,
        kind,
        amountCents: body.amountCents,
        toAccountNumber: body.toAccountNumber,
        memo: body.memo,
        idemKey,
        ip: req.ip,
      }),
    );
    res.status(result.replayed ? 200 : 201).json(result);
  };
}

r.post('/me/deposit', handler('DEPOSIT', depositSchema));
r.post('/me/withdraw', handler('WITHDRAWAL', withdrawSchema));
r.post('/me/transfer', handler('TRANSFER', transferSchema));

export default r;
