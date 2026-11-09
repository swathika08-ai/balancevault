// Creates the first administrator directly in the database (no HTTP, no BOOTSTRAP_TOKEN).
// Usage: ADMIN_EMAIL=you@example.com ADMIN_NAME="Your Name" ADMIN_PASSWORD='long-password' npm run create-admin
import { withTx, pool } from './db.js';
import { hashPassword } from './auth.js';
import { record } from './audit.js';
import { runMigrations } from './migrate.js';

const { ADMIN_EMAIL, ADMIN_NAME, ADMIN_PASSWORD } = process.env;
if (!ADMIN_EMAIL || !ADMIN_NAME || !ADMIN_PASSWORD || ADMIN_PASSWORD.length < 12) {
  console.error('Set ADMIN_EMAIL, ADMIN_NAME and ADMIN_PASSWORD (min 12 characters).');
  process.exit(1);
}

try {
  await runMigrations();
  const hash = await hashPassword(ADMIN_PASSWORD);
  await withTx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(727002)');
    const existing = await c.query("SELECT 1 FROM users WHERE role = 'ADMIN' LIMIT 1");
    if (existing.rowCount) throw new Error('An administrator already exists. Use the admin UI to add more.');
    const { rows } = await c.query(
      `INSERT INTO users(email, full_name, password_hash, role) VALUES ($1,$2,$3,'ADMIN') RETURNING id`,
      [ADMIN_EMAIL.trim().toLowerCase(), ADMIN_NAME.trim(), hash],
    );
    await record(c, { actorId: rows[0].id, actorRole: 'ADMIN', action: 'ADMIN_BOOTSTRAPPED', target: `user:${rows[0].id}`, details: { via: 'cli' } });
  });
  console.log('Administrator created.');
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
