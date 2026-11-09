// Tests run against a REAL throwaway Postgres: set DATABASE_URL (see README), never a real database.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET ||= 'test-secret-test-secret-test-secret-1234';
process.env.BOOTSTRAP_TOKEN ||= 'test-bootstrap-token';
process.env.AUTH_RATE_MAX = '100000';
process.env.GENERAL_RATE_MAX = '100000';
process.env.REDIS_URL = ''; // tests use the in-memory limiter
if (!process.env.DATABASE_URL) {
  throw new Error('Set DATABASE_URL to a throwaway Postgres database to run the tests');
}

const { createApp } = await import('../src/app.js');
export const { pool } = await import('../src/db.js');
const { hashPassword } = await import('../src/auth.js');
const { runMigrations } = await import('../src/migrate.js');

await runMigrations();

export const PASSWORD = 'correct-horse-battery-1';
const uniq = () => Math.random().toString(36).slice(2, 10);

let server;
let base;
export async function start() {
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
}
export async function stop() {
  await new Promise((r) => server.close(r));
  await pool.end();
}

export async function call(method, path, { token, body, headers = {} } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined || method === 'GET' ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

export async function makeAdmin() {
  const email = `admin-${uniq()}@test.local`;
  await pool.query(
    `INSERT INTO users(email, full_name, password_hash, role) VALUES ($1,'Test Admin',$2,'ADMIN')`,
    [email, await hashPassword(PASSWORD)],
  );
  const { data } = await call('POST', '/api/auth/login', { body: { email, password: PASSWORD } });
  return { email, token: data.token };
}

export async function registerHolder() {
  const email = `holder-${uniq()}@test.local`;
  const reg = await call('POST', '/api/auth/register', { body: { email, fullName: 'Test Holder', password: PASSWORD } });
  const login = await call('POST', '/api/auth/login', { body: { email, password: PASSWORD } });
  return { email, userId: reg.data.user.id, token: login.data.token };
}

export const onboardingBody = { phone: '9876543210', address: '12 Test Street, Vijayawada', idDocumentRef: 'SYNTH-0001' };

/** Register, submit onboarding, get approved by `admin`, return holder with accountNumber. */
export async function makeApprovedHolder(admin) {
  const h = await registerHolder();
  await call('POST', '/api/onboarding', { token: h.token, body: onboardingBody });
  const list = await call('GET', '/api/admin/onboarding?status=PENDING', { token: admin.token });
  const app = list.data.applications.find((a) => a.email === h.email);
  await call('POST', `/api/admin/onboarding/${app.id}/decision`, { token: admin.token, body: { decision: 'APPROVE' } });
  const me = await call('GET', '/api/accounts/me', { token: h.token });
  return { ...h, accountNumber: me.data.account.accountNumber };
}

export const idem = () => ({ 'Idempotency-Key': `key-${uniq()}-${uniq()}` });
