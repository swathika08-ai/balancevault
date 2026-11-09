import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import express from 'express';
import {
  PASSWORD, call, idem, makeAdmin, makeApprovedHolder, onboardingBody, pool, registerHolder, start, stop,
} from './helpers.js';
import { rateLimit } from '../src/rateLimit.js';

let admin;
before(async () => {
  await start();
  admin = await makeAdmin();
});
after(stop);

describe('authentication', () => {
  it('rejects requests with no token', async () => {
    assert.equal((await call('GET', '/api/accounts/me')).status, 401);
    assert.equal((await call('GET', '/api/admin/users')).status, 401);
  });

  it('rejects a token signed with alg=none', async () => {
    const h = await registerHolder();
    const real = jwt.decode(h.token);
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const forged = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: real.sub, tv: real.tv })}.`;
    assert.equal((await call('GET', '/api/auth/me', { token: forged })).status, 401);
  });

  it('logout revokes the token immediately', async () => {
    const h = await registerHolder();
    assert.equal((await call('GET', '/api/auth/me', { token: h.token })).status, 200);
    await call('POST', '/api/auth/logout', { token: h.token });
    assert.equal((await call('GET', '/api/auth/me', { token: h.token })).status, 401);
  });

  it('locks an account after repeated wrong passwords and uses one generic message', async () => {
    const h = await registerHolder();
    let last;
    for (let i = 0; i < 5; i++) last = await call('POST', '/api/auth/login', { body: { email: h.email, password: 'wrong-password-123' } });
    assert.equal(last.status, 401);
    const correct = await call('POST', '/api/auth/login', { body: { email: h.email, password: PASSWORD } });
    assert.equal(correct.status, 401, 'correct password must be refused while locked');
    assert.equal(correct.data.error, last.data.error);
  });
});

describe('authorisation (server-side RBAC)', () => {
  it('register ignores/rejects a client-supplied role', async () => {
    const res = await call('POST', '/api/auth/register', {
      body: { email: `evil-${Date.now()}@test.local`, fullName: 'Evil', password: PASSWORD, role: 'ADMIN' },
    });
    assert.equal(res.status, 400);
  });

  it('a holder gets 403 on every admin route', async () => {
    const h = await registerHolder();
    for (const [m, p] of [
      ['GET', '/api/admin/users'],
      ['GET', '/api/admin/onboarding'],
      ['GET', '/api/admin/accounts'],
      ['GET', '/api/admin/audit'],
      ['GET', '/api/admin/audit/verify'],
      ['POST', '/api/admin/users'],
    ]) {
      assert.equal((await call(m, p, { token: h.token, body: {} })).status, 403, `${m} ${p}`);
    }
  });

  it('an admin cannot use holder money routes', async () => {
    const res = await call('POST', '/api/accounts/me/deposit', { token: admin.token, headers: idem(), body: { amountCents: 100 } });
    assert.equal(res.status, 403);
  });

  it('a holder cannot approve their own onboarding', async () => {
    const h = await registerHolder();
    const sub = await call('POST', '/api/onboarding', { token: h.token, body: onboardingBody });
    const res = await call('POST', `/api/admin/onboarding/${sub.data.application.id}/decision`, {
      token: h.token, body: { decision: 'APPROVE' },
    });
    assert.equal(res.status, 403);
  });

  it('a disabled user is locked out at once', async () => {
    const h = await registerHolder();
    await call('POST', `/api/admin/users/${h.userId}/status`, { token: admin.token, body: { status: 'DISABLED' } });
    assert.equal((await call('GET', '/api/auth/me', { token: h.token })).status, 401);
  });

  it('an admin cannot disable themselves', async () => {
    const me = await call('GET', '/api/auth/me', { token: admin.token });
    const res = await call('POST', `/api/admin/users/${me.data.user.id}/status`, { token: admin.token, body: { status: 'DISABLED' } });
    assert.equal(res.status, 400);
  });
});

describe('onboarding', () => {
  it('creates an account only after admin approval, and only once', async () => {
    const h = await registerHolder();
    assert.equal((await call('GET', '/api/accounts/me', { token: h.token })).data.account, null);
    const sub = await call('POST', '/api/onboarding', { token: h.token, body: onboardingBody });
    assert.equal(sub.status, 201);
    assert.equal((await call('POST', '/api/onboarding', { token: h.token, body: onboardingBody })).status, 409);
    const id = sub.data.application.id;
    const ok = await call('POST', `/api/admin/onboarding/${id}/decision`, { token: admin.token, body: { decision: 'APPROVE' } });
    assert.equal(ok.status, 200);
    assert.match(ok.data.accountNumber, /^BV[0-9]{12}$/);
    assert.equal((await call('POST', `/api/admin/onboarding/${id}/decision`, { token: admin.token, body: { decision: 'REJECT' } })).status, 409);
  });
});

describe('ledger', () => {
  it('deposit, overdraft refused, transfer moves money, balances are per-user', async () => {
    const a = await makeApprovedHolder(admin);
    const b = await makeApprovedHolder(admin);
    assert.equal((await call('POST', '/api/accounts/me/deposit', { token: a.token, headers: idem(), body: { amountCents: 10000 } })).data.balanceCents, 10000);
    assert.equal((await call('POST', '/api/accounts/me/withdraw', { token: a.token, headers: idem(), body: { amountCents: 20000 } })).status, 422);
    const t = await call('POST', '/api/accounts/me/transfer', {
      token: a.token, headers: idem(), body: { toAccountNumber: b.accountNumber, amountCents: 2500 },
    });
    assert.equal(t.status, 201);
    assert.equal((await call('GET', '/api/accounts/me', { token: a.token })).data.account.balanceCents, 7500);
    assert.equal((await call('GET', '/api/accounts/me', { token: b.token })).data.account.balanceCents, 2500);
    const bTx = (await call('GET', '/api/accounts/me/transactions', { token: b.token })).data.transactions;
    assert.equal(bTx.length, 1, 'B sees only their own entries');
  });

  it('rejects negative, zero, fractional and oversized amounts and self-transfer', async () => {
    const a = await makeApprovedHolder(admin);
    for (const amountCents of [-5, 0, 1.5, 999_999_999_999]) {
      assert.equal((await call('POST', '/api/accounts/me/deposit', { token: a.token, headers: idem(), body: { amountCents } })).status, 400);
    }
    const self = await call('POST', '/api/accounts/me/transfer', {
      token: a.token, headers: idem(), body: { toAccountNumber: a.accountNumber, amountCents: 100 },
    });
    assert.equal(self.status, 400);
  });

  it('requires an Idempotency-Key and replays instead of double-posting', async () => {
    const a = await makeApprovedHolder(admin);
    assert.equal((await call('POST', '/api/accounts/me/deposit', { token: a.token, body: { amountCents: 100 } })).status, 400);
    const headers = idem();
    const first = await call('POST', '/api/accounts/me/deposit', { token: a.token, headers, body: { amountCents: 5000 } });
    const again = await call('POST', '/api/accounts/me/deposit', { token: a.token, headers, body: { amountCents: 5000 } });
    assert.equal(again.data.transferId, first.data.transferId);
    assert.equal((await call('GET', '/api/accounts/me', { token: a.token })).data.account.balanceCents, 5000);
    const reuse = await call('POST', '/api/accounts/me/deposit', { token: a.token, headers, body: { amountCents: 9999 } });
    assert.equal(reuse.status, 422);
  });

  it('parallel withdrawals cannot overdraw: exactly one succeeds', async () => {
    const a = await makeApprovedHolder(admin);
    await call('POST', '/api/accounts/me/deposit', { token: a.token, headers: idem(), body: { amountCents: 10000 } });
    const results = await Promise.all(
      Array.from({ length: 6 }, () => call('POST', '/api/accounts/me/withdraw', { token: a.token, headers: idem(), body: { amountCents: 10000 } })),
    );
    assert.equal(results.filter((r) => r.status === 201).length, 1);
    assert.equal((await call('GET', '/api/accounts/me', { token: a.token })).data.account.balanceCents, 0);
  });

  it('a frozen account cannot move money', async () => {
    const a = await makeApprovedHolder(admin);
    await call('POST', '/api/accounts/me/deposit', { token: a.token, headers: idem(), body: { amountCents: 1000 } });
    const accounts = await call('GET', '/api/admin/accounts', { token: admin.token });
    const acc = accounts.data.accounts.find((x) => x.account_number === a.accountNumber);
    await call('POST', `/api/admin/accounts/${acc.id}/freeze`, { token: admin.token, body: { frozen: true } });
    assert.equal((await call('POST', '/api/accounts/me/withdraw', { token: a.token, headers: idem(), body: { amountCents: 100 } })).status, 403);
  });
});

describe('audit trail', () => {
  it('chain verifies, and the database refuses UPDATE/DELETE/TRUNCATE', async () => {
    const res = await call('GET', '/api/admin/audit/verify', { token: admin.token });
    assert.equal(res.status, 200);
    assert.equal(res.data.ok, true);
    await assert.rejects(pool.query("UPDATE audit_log SET action = 'HACKED' WHERE id = (SELECT min(id) FROM audit_log)"), /append-only/);
    await assert.rejects(pool.query('DELETE FROM audit_log'), /append-only/);
    await assert.rejects(pool.query('TRUNCATE audit_log'), /append-only/);
    await assert.rejects(pool.query("UPDATE ledger_entries SET amount_cents = 1"), /append-only/);
  });

  it('records money movement and failed logins', async () => {
    const a = await makeApprovedHolder(admin);
    await call('POST', '/api/accounts/me/deposit', { token: a.token, headers: idem(), body: { amountCents: 100 } });
    await call('POST', '/api/auth/login', { body: { email: a.email, password: 'definitely-wrong-1' } });
    const { rows } = await pool.query(
      "SELECT action FROM audit_log WHERE actor_id = (SELECT id FROM users WHERE email=$1)",
      [a.email],
    );
    const actions = rows.map((r) => r.action);
    for (const wanted of ['USER_REGISTERED', 'ONBOARDING_SUBMITTED', 'MONEY_DEPOSIT', 'LOGIN_FAILED']) {
      assert.ok(actions.includes(wanted), `missing ${wanted}`);
    }
  });
});

describe('bootstrap endpoint', () => {
  const body = { email: 'boot@test.local', fullName: 'Boot Admin', password: PASSWORD };
  it('rejects a wrong token', async () => {
    assert.equal((await call('POST', '/api/auth/bootstrap-admin', { headers: { 'X-Bootstrap-Token': 'nope' }, body })).status, 403);
  });
  it('refuses once any admin exists', async () => {
    const res = await call('POST', '/api/auth/bootstrap-admin', { headers: { 'X-Bootstrap-Token': process.env.BOOTSTRAP_TOKEN }, body });
    assert.equal(res.status, 409);
  });
});

describe('platform', () => {
  it('health and readiness respond', async () => {
    assert.equal((await call('GET', '/healthz')).status, 200);
    assert.equal((await call('GET', '/readyz')).status, 200);
  });

  it('error responses never leak internals', async () => {
    const res = await call('GET', '/api/admin/users/not-a-uuid/nope', { token: admin.token });
    assert.equal(res.status, 404);
    assert.ok(!JSON.stringify(res.data).includes('node_modules'));
  });

  it('rate limiter returns 429 after the limit', async () => {
    const app = express();
    app.use(rateLimit({ name: `t-${Date.now()}`, windowSec: 60, max: 3 }));
    app.get('/', (req, res) => res.json({ ok: true }));
    const srv = app.listen(0);
    await new Promise((r) => srv.once('listening', r));
    const url = `http://127.0.0.1:${srv.address().port}/`;
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await fetch(url)).status);
    srv.close();
    assert.deepEqual(codes, [200, 200, 200, 429, 429]);
  });
});
