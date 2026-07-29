import { cache } from '../redis.js';

/**
 * Fixed-window counter in Redis.
 *
 * Question answering costs money per call, so the /ask limit is the one that
 * actually protects the bill; the login limit protects against credential
 * stuffing. `keyFn` decides what a "caller" is — user id once authenticated,
 * IP before that.
 */
export function rateLimit({ name, limit, windowSeconds, keyFn }) {
  return async function rateLimitMiddleware(req, res, next) {
    try {
      const bucket = Math.floor(Date.now() / 1000 / windowSeconds);
      const key = `ratelimit:${name}:${keyFn(req)}:${bucket}`;

      const count = await cache.incr(key);
      if (count === 1) {
        await cache.expire(key, windowSeconds);
      }

      const remaining = Math.max(0, limit - count);
      res.set('X-RateLimit-Limit', String(limit));
      res.set('X-RateLimit-Remaining', String(remaining));

      if (count > limit) {
        const ttl = await cache.ttl(key);
        res.set('Retry-After', String(Math.max(ttl, 1)));
        return res.status(429).json({
          error: 'Rate limit exceeded',
          retry_after_seconds: Math.max(ttl, 1),
        });
      }

      next();
    } catch (err) {
      // A Redis outage should not take down the API. Log and let the request
      // through rather than failing closed on a non-critical dependency.
      console.error('[ratelimit] falling open:', err.message);
      next();
    }
  };
}

export const ipKey = (req) => req.ip;
export const userKey = (req) => `u${req.user.id}`;
