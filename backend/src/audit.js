import crypto from 'node:crypto';
import { pool } from './db.js';

// Deterministic JSON: object keys sorted recursively.
export function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function payloadOf(e) {
  return stable({
    ts: e.ts,
    actorId: e.actorId ?? null,
    actorRole: e.actorRole ?? null,
    action: e.action,
    target: e.target ?? null,
    details: e.details ?? {},
    ip: e.ip ?? null,
  });
}

/**
 * Append an audit entry using the CALLER'S transaction client, so the entry commits
 * or rolls back together with the action it describes. Each row's hash covers the
 * previous row's hash, so editing or removing history breaks the chain.
 */
export async function record(client, entry) {
  // Serialise writers so prev_hash always points at the true previous row.
  await client.query('SELECT pg_advisory_xact_lock(727001)');
  const { rows } = await client.query('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1');
  const prev = rows[0]?.hash ?? 'GENESIS';
  const full = { ...entry, ts: new Date().toISOString() };
  const hash = sha256(prev + payloadOf(full));
  await client.query(
    `INSERT INTO audit_log(ts, actor_id, actor_role, action, target, details, ip, prev_hash, hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      full.ts,
      full.actorId ?? null,
      full.actorRole ?? null,
      full.action,
      full.target ?? null,
      JSON.stringify(full.details ?? {}),
      full.ip ?? null,
      prev,
      hash,
    ],
  );
}

/** Recompute the whole chain. Returns { ok, checked, brokenAtId }. */
export async function verifyChain() {
  const { rows } = await pool.query('SELECT * FROM audit_log ORDER BY id ASC');
  let prev = 'GENESIS';
  for (const r of rows) {
    const expected = sha256(
      prev +
        payloadOf({
          ts: r.ts,
          actorId: r.actor_id,
          actorRole: r.actor_role,
          action: r.action,
          target: r.target,
          details: r.details,
          ip: r.ip,
        }),
    );
    if (r.prev_hash !== prev || r.hash !== expected) {
      return { ok: false, checked: rows.length, brokenAtId: r.id };
    }
    prev = r.hash;
  }
  return { ok: true, checked: rows.length, brokenAtId: null };
}
