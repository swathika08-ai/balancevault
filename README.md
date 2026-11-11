# BalanceVault

A small account-management platform: role-based access, user onboarding with admin approval, a
append-only money ledger, and a tamper-evident audit log. **Demo only. Synthetic data, no real funds.**

- Frontend: React + Vite (`frontend/`)
- Backend: Node 22 + Express 5 (`backend/`)
- Database: PostgreSQL (plain SQL migrations in `backend/migrations/`)
- Rate limiting: Redis (falls back to an in-memory limiter if `REDIS_URL` is empty)

## Features

| Area | What it does |
|---|---|
| Auth | Register, login (scrypt hashes, 1h JWT), logout that revokes tokens, lockout after 5 bad passwords |
| Roles | `ACCOUNT_HOLDER` and `ADMIN`, enforced by server middleware on every route (UI only hides buttons) |
| Onboarding | Holder submits details, admin approves/rejects, approval creates the account |
| Money | Deposit, withdraw, transfer. Integer cents, append-only ledger, balance = sum of entries, no overdraft, idempotency keys |
| Admin | Review onboarding, enable/disable users, add admins, view accounts, freeze/unfreeze |
| Audit | Every security-relevant action is logged in the same DB transaction; entries are hash-chained; admin can verify the chain |
| Ops | `/healthz`, `/readyz`, rate limiting, central error handler, security headers |

## Run locally

Needs Node 22+, Docker (for Postgres/Redis).

```bash
docker compose up -d
cp .env.example backend/.env        # edit JWT_SECRET (32+ chars)
npm install
npm run migrate
ADMIN_EMAIL=you@example.com ADMIN_NAME="Your Name" ADMIN_PASSWORD='a-long-password-123' npm run create-admin
npm run dev:backend                 # http://localhost:4000
echo 'VITE_API_URL=http://localhost:4000' > frontend/.env
npm run dev:frontend                # http://localhost:5173
```

## Tests

Tests run against a real, throwaway Postgres (never point them at data you care about):

```bash
docker compose up -d postgres_test
DATABASE_URL=postgresql://balancevault:balancevault@localhost:5433/balancevault_test npm test
```

## First administrator

Two ways, both refuse to run if an admin already exists:

1. CLI (preferred): `npm run create-admin` with `ADMIN_EMAIL`, `ADMIN_NAME`, `ADMIN_PASSWORD`.
2. HTTP, for hosts with no shell: set `BOOTSTRAP_TOKEN`, then
   `POST /api/auth/bootstrap-admin` with header `X-Bootstrap-Token` and body `{email, fullName, password}`.
   Remove `BOOTSTRAP_TOKEN` afterwards to disable the endpoint.

## API summary

| Method & path | Who |
|---|---|
| `POST /api/auth/register`, `/login` | public (strict rate limit) |
| `POST /api/auth/logout`, `GET /api/auth/me` | any signed-in user |
| `POST /api/onboarding`, `GET /api/onboarding/me` | holder |
| `GET /api/accounts/me`, `/me/transactions` | holder |
| `POST /api/accounts/me/deposit \| withdraw \| transfer` | holder (needs `Idempotency-Key` header) |
| `GET /api/admin/onboarding`, `POST /api/admin/onboarding/:id/decision` | admin |
| `GET/POST /api/admin/users`, `POST /api/admin/users/:id/status` | admin |
| `GET /api/admin/accounts`, `POST /api/admin/accounts/:id/freeze` | admin |
| `GET /api/admin/audit`, `GET /api/admin/audit/verify` | admin |

Holder routes contain no account id: the account is always found from the signed-in user, so there is
nothing to tamper with (no IDOR surface). See `THREATS.md` for the full reasoning.

## Deployment

See `DEPLOY.md` (Neon + Render + Vercel, all free tier).

## Known limitations (honest list)

- Money is synthetic: deposits are self-service so the demo works without a payment provider.
- JWT is kept in `sessionStorage`; an XSS bug would expose it. Mitigated by React escaping and helmet, not eliminated.
- Duplicate-email registration returns 409, which reveals that an email exists.
- The audit hash chain detects tampering; it cannot stop someone with full database-owner rights from rewriting the entire chain. (The append-only triggers stop the application role.)
- No email verification, no password reset, no 2FA.

## Verification status

Update this table only with things you have actually run and seen work. Do not tick what you have not tested.

| Check | Verified? |
|---|---|
| `npm test` passes locally against a throwaway Postgres | [✅] |
| Backend deployed, `/healthz` and `/readyz` return 200 | [✅] |
| First admin created on the live database | [✅] |
| Admin login works on the live site | [✅] |
| Register -> onboard -> approve -> deposit/transfer works on the live site | [✅] |
| Audit "Verify hash chain" shows intact on the live site | [✅] |
