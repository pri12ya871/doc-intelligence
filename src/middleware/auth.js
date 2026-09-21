import jwt from 'jsonwebtoken';
import { config } from '../config.js';

export function signToken(user, { expiresIn = config.jwtExpiresIn } = {}) {
  return jwt.sign({ sub: String(user.id), email: user.email }, config.jwtSecret, { expiresIn });
}

/**
 * Populates req.user from a Bearer token. Every document and chunk query in
 * this app filters on req.user.id — that filter is the tenant boundary.
 */
export function requireAuth(req, res, next) {
  const header = req.get('authorization') ?? '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header' });
  }

  try {
    const payload = jwt.verify(token, config.jwtSecret);
    req.user = { id: Number(payload.sub), email: payload.email };
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}
