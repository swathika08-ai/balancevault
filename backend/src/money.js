import crypto from 'node:crypto';
import { record } from './audit.js';
import { HttpError } from './errors.js';

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export async function getBalance(client, accountId) {
  const { rows } = await client.query(
    `SELECT COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount_cents ELSE -amount_cents END), 0)::bigint AS bal
       FROM ledger_entries WHERE account_id = $1`,
    [accountId],
  );
  return Number(rows[0].bal);
}

/**
 * Move money for the AUTHENTICATED user's own account. There is deliberately no
 * account id parameter: the source account is always derived from user.id on the server.
 * Must run inside withTx().
 */
export async function moveMoney(c, { user, kind, amountCents, toAccountNumber, memo, idemKey, ip }) {
  const reqHash = sha256(JSON.stringify({ kind, amountCents, to: toAccountNumber ?? null, memo: memo ?? null }));

  // Idempotency: a retry with the same key returns the stored result and never posts twice.
  // A concurrent duplicate blocks on this insert until the first transaction finishes.
  const ins = await c.query(
    'INSERT INTO idempotency_keys(user_id, key, request_hash) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING key',
    [user.id, idemKey, reqHash],
  );
  if (!ins.rowCount) {
    const { rows } = await c.query('SELECT request_hash, response FROM idempotency_keys WHERE user_id=$1 AND key=$2', [
      user.id,
      idemKey,
    ]);
    if (rows[0].request_hash !== reqHash) throw new HttpError(422, 'Idempotency-Key was already used for a different request');
    if (!rows[0].response) throw new HttpError(409, 'request still in progress');
    return { ...rows[0].response, replayed: true };
  }

  const { rows: own } = await c.query('SELECT id FROM accounts WHERE user_id = $1', [user.id]);
  if (!own[0]) throw new HttpError(409, 'no account yet: complete onboarding and wait for approval');

  let destId = null;
  if (kind === 'TRANSFER') {
    const { rows } = await c.query('SELECT id FROM accounts WHERE account_number = $1', [toAccountNumber]);
    if (!rows[0]) throw new HttpError(404, 'recipient not found');
    if (rows[0].id === own[0].id) throw new HttpError(400, 'cannot transfer to your own account');
    destId = rows[0].id;
  }

  // Lock both accounts in a fixed (id) order so concurrent transfers cannot deadlock,
  // and so two simultaneous withdrawals cannot both pass the balance check.
  const ids = [own[0].id, destId].filter(Boolean);
  const { rows: locked } = await c.query(
    'SELECT id, status FROM accounts WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE',
    [ids],
  );
  const statusOf = (id) => locked.find((a) => a.id === id)?.status;
  if (statusOf(own[0].id) !== 'ACTIVE') throw new HttpError(403, 'your account is frozen');
  if (destId && statusOf(destId) !== 'ACTIVE') throw new HttpError(404, 'recipient not found');

  const before = await getBalance(c, own[0].id);
  if (kind !== 'DEPOSIT' && before < amountCents) throw new HttpError(422, 'insufficient funds');

  const transferId = crypto.randomUUID();
  const entry = (accountId, direction) =>
    c.query(
      'INSERT INTO ledger_entries(transfer_id, account_id, direction, amount_cents, kind, memo) VALUES ($1,$2,$3,$4,$5,$6)',
      [transferId, accountId, direction, amountCents, kind, memo ?? null],
    );
  if (kind === 'DEPOSIT') await entry(own[0].id, 'CREDIT');
  if (kind === 'WITHDRAWAL') await entry(own[0].id, 'DEBIT');
  if (kind === 'TRANSFER') {
    await entry(own[0].id, 'DEBIT');
    await entry(destId, 'CREDIT');
  }

  const balanceCents = before + (kind === 'DEPOSIT' ? amountCents : -amountCents);
  const response = { transferId, kind, amountCents, balanceCents };

  await record(c, {
    actorId: user.id,
    actorRole: user.role,
    action: `MONEY_${kind}`,
    target: `account:${own[0].id}`,
    details: { transferId, amountCents, to: toAccountNumber ?? null },
    ip,
  });
  await c.query('UPDATE idempotency_keys SET response = $3 WHERE user_id = $1 AND key = $2', [
    user.id,
    idemKey,
    JSON.stringify(response),
  ]);
  return response;
}
