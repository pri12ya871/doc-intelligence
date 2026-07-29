import express from 'express';
import bcrypt from 'bcryptjs';
import { query } from '../db.js';
import { signToken } from '../middleware/auth.js';
import { rateLimit, ipKey } from '../middleware/rateLimit.js';
import { config } from '../config.js';

export const authRouter = express.Router();

const loginLimiter = rateLimit({
  name: 'login',
  limit: config.loginRateLimitPer15Min,
  windowSeconds: 15 * 60,
  keyFn: ipKey,
});

function validateCredentials(body) {
  const email = String(body?.email ?? '').trim().toLowerCase();
  const password = String(body?.password ?? '');

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { error: 'A valid email address is required' };
  }
  if (password.length < 8) {
    return { error: 'Password must be at least 8 characters' };
  }
  return { email, password };
}

authRouter.post('/register', loginLimiter, async (req, res, next) => {
  try {
    const parsed = validateCredentials(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    const passwordHash = await bcrypt.hash(parsed.password, 12);

    const { rows } = await query(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email',
      [parsed.email, passwordHash],
    );

    res.status(201).json({ token: signToken(rows[0]), user: rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'An account with that email already exists' });
    }
    next(err);
  }
});

authRouter.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const parsed = validateCredentials(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    const { rows } = await query(
      'SELECT id, email, password_hash FROM users WHERE email = $1',
      [parsed.email],
    );
    const user = rows[0];

    // Hash a dummy value when the user is missing so that a wrong email and a
    // wrong password take the same time to answer.
    const valid = user
      ? await bcrypt.compare(parsed.password, user.password_hash)
      : await bcrypt.compare(parsed.password, '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvali');

    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    res.json({ token: signToken(user), user: { id: user.id, email: user.email } });
  } catch (err) {
    next(err);
  }
});
