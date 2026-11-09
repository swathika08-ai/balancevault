# Threat model

Assets: account balances and the ledger, personal details in onboarding applications, admin powers,
the integrity of the audit log. Attackers considered: anonymous internet user, a logged-in account holder
trying to reach other holders' data or admin powers, a stolen/old token, a malicious or mistaken admin.

Each row names the control and the test (in `backend/tests/security.test.js`) that proves it.

| # | Threat | Control | Test |
|---|---|---|---|
| 1 | Anonymous access to protected data | `requireAuth` on every non-public route returns 401 | "rejects requests with no token" |
| 2 | Forged JWT (`alg=none`, wrong signature) | `jwt.verify` pinned to `HS256` with a 32+ char secret | "rejects a token signed with alg=none" |
| 3 | Holder reaches admin features | `requireRole('ADMIN')` mounted for the whole admin router; role read from the DB, not the token | "a holder gets 403 on every admin route" |
| 4 | Privilege escalation at signup (mass assignment) | Zod `.strict()` rejects unknown fields; register always inserts `ACCOUNT_HOLDER` | "register ignores/rejects a client-supplied role" |
| 5 | Holder A reads or moves holder B's money (IDOR) | No account id in any holder route; account found via `req.user.id`; transactions query joins on `user_id` | "balances are per-user" |
| 6 | Admin moves customer money | Holder money routes are `ACCOUNT_HOLDER` only (separation of duties) | "an admin cannot use holder money routes" |
| 7 | Holder approves own onboarding | Decision endpoint is admin-only | "a holder cannot approve their own onboarding" |
| 8 | Stolen token after logout/disable | `token_version` is checked on every request and bumped on logout/disable | "logout revokes the token", "a disabled user is locked out at once" |
| 9 | Password guessing | scrypt hashing, 5-strike 15-minute lockout, rate limit on `/api/auth` (Redis), generic error message, dummy hash to equalise timing | "locks an account after repeated wrong passwords" |
| 10 | Overdraft / double spend by racing requests | Row locks on accounts (`FOR UPDATE`, fixed order) inside one transaction; balance computed from the ledger | "parallel withdrawals cannot overdraw" |
| 11 | Replay of a money request (retry, double-click) | Mandatory `Idempotency-Key`; replay returns the stored result; key reuse with different body is 422 | "replays instead of double-posting" |
| 12 | Negative, zero, fractional or huge amounts | Zod: positive integer cents, max per operation | "rejects negative, zero, fractional and oversized amounts" |
| 13 | Rewriting history (ledger or audit) | DB triggers refuse UPDATE/DELETE/TRUNCATE; audit rows are SHA-256 hash-chained; admin can verify | "chain verifies, and the database refuses..." |
| 14 | Actions with no record | `record()` runs in the same transaction as the action, so no action without a log row and no log row without an action | "records money movement and failed logins" |
| 15 | Bootstrap endpoint abuse | Disabled unless `BOOTSTRAP_TOKEN` set; constant-time compare; advisory lock; refuses if any admin exists; failed attempts audited | "bootstrap endpoint" tests |
| 16 | Frozen / compromised account keeps moving money | Account status is checked under lock before every movement | "a frozen account cannot move money" |
| 17 | Abuse / flooding | Global and stricter auth rate limits; 10 KB body limit; health endpoints exempt | "rate limiter returns 429 after the limit" |
| 18 | Information leakage in errors | Central handler returns generic 500; Zod issues only on 400; no stack traces | "error responses never leak internals" |
| 19 | SQL injection | Every query is parameterised; ids validated as UUIDs first | (review: no string-built SQL in `src/`) |
| 20 | Clickjacking, sniffing, etc. | `helmet` default headers; CORS limited to configured origins | — |

## Accepted / not covered

- XSS stealing the `sessionStorage` token (React escapes output; no `dangerouslySetInnerHTML` is used).
- A database owner rewriting the whole audit chain (would need an external anchor such as an off-site hash).
- Email enumeration through the 409 on duplicate registration.
- No MFA, no email verification, no password reset.
- Admins are trusted, but every admin action is audited, and an admin cannot disable themselves.
