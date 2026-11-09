import Redis from 'ioredis';
import { config } from './config.js';

const memory = new Map(); // key -> { count, resetAt }

function memoryHit(key, windowSec) {
  const now = Date.now();
  const entry = memory.get(key);
  if (!entry || entry.resetAt <= now) {
    memory.set(key, { count: 1, resetAt: now + windowSec * 1000 });
    return 1;
  }
  entry.count += 1;
  return entry.count;
}

let redis = null;
if (config.redisUrl) {
  redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 1, enableOfflineQueue: false });
  redis.on('error', (e) => console.error('redis error:', e.message));
}

export async function pingRedis() {
  if (!redis) return 'disabled';
  await redis.ping();
  return 'ok';
}

async function hit(key, windowSec) {
  if (redis) {
    try {
      const n = await redis.incr(key);
      if (n === 1) await redis.expire(key, windowSec);
      return n;
    } catch (e) {
      console.error('rate limit falling back to memory:', e.message);
    }
  }
  return memoryHit(key, windowSec);
}

export function rateLimit({ name, windowSec, max }) {
  return async (req, res, next) => {
    try {
      const n = await hit(`rl:${name}:${req.ip}`, windowSec);
      if (n > max) {
        res.set('Retry-After', String(windowSec));
        return res.status(429).json({ error: 'too_many_requests' });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
