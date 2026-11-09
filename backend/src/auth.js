import crypto from 'node:crypto';
import { promisify } from 'node:util';
import jwt from 'jsonwebtoken';
import { config } from './config.js';
import { pool } from './db.js';

const scrypt = promisify(crypto.scrypt);

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  const [scheme, saltHex, keyHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, 'hex');
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

// Used when the email does not exist so response time does not reveal valid emails.
export const DUMMY_HASH = await hashPassword('dummy-password-for-timing');

export function signToken(user) {
  return jwt.sign({ sub: user.id, tv: user.token_version }, config.jwtSecret, {
    algorithm: 'HS256',
    expiresIn: '1h',
  });
}

/**
 * Authentication. The token only proves WHO; role and status are always re-read from
 * the database, so a demoted/disabled user or a logged-out token stops working at once.
 */
export async function requireAuth(req, res, next) {
  try {
    const [scheme, token] = (req.headers.authorization || '').split(' ');
    if (scheme !== 'Bearer' || !token) return res.status(401).json({ error: 'unauthenticated' });
    let payload;
    try {
      payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
    } catch {
      return res.status(401).json({ error: 'unauthenticated' });
    }
    const { rows } = await pool.query(
      'SELECT id, email, full_name, role, status, token_version FROM users WHERE id = $1',
      [payload.sub],
    );
    const user = rows[0];
    if (!user || user.status !== 'ACTIVE' || user.token_version !== payload.tv) {
      return res.status(401).json({ error: 'unauthenticated' });
    }
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

/** Authorisation by role. Always mount AFTER requireAuth. */
export const requireRole =
  (...roles) =>
  (req, res, next) =>
    roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'forbidden' });

export const publicUser = (u) => ({
  id: u.id,
  email: u.email,
  fullName: u.full_name,
  role: u.role,
});
