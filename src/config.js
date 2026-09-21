import crypto from 'node:crypto';
import 'dotenv/config';

const nodeEnv = process.env.NODE_ENV ?? 'development';

/** Treats an unset or blank variable the same way. */
function optional(name) {
  const value = process.env[name]?.trim();
  return value || undefined;
}

/**
 * A signing secret must never be improvised in production — tokens signed with
 * a guessable or ephemeral key are worthless. In development a missing one is
 * generated so a fresh clone runs immediately, at the cost of invalidating
 * existing sessions on every restart.
 */
function resolveJwtSecret() {
  const configured = optional('JWT_SECRET');
  if (configured) return configured;

  if (nodeEnv === 'production') {
    throw new Error('JWT_SECRET must be set in production');
  }

  console.warn('[config] JWT_SECRET is not set — using a temporary one; logins reset on restart.');
  return crypto.randomBytes(48).toString('hex');
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  nodeEnv,

  // Both are optional. Unset means "run locally with no external services":
  // embedded Postgres via PGlite, and an in-memory cache with in-process
  // ingestion. See src/db.js and src/redis.js.
  databaseUrl: optional('DATABASE_URL'),
  redisUrl: optional('REDIS_URL'),

  jwtSecret: resolveJwtSecret(),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '7d',

  // Answers can come from either provider — whichever key is set gets used
  // (Anthropic preferred when both are). ANSWER_PROVIDER=anthropic|gemini
  // forces the choice explicitly.
  anthropicApiKey: optional('ANTHROPIC_API_KEY'),
  answerModel: process.env.ANSWER_MODEL ?? 'claude-opus-5',
  geminiApiKey: optional('GEMINI_API_KEY'),
  // gemini-flash-latest tracks Google's current flash model; pinned names like
  // gemini-2.5-flash get closed to new accounts as generations rotate.
  geminiModel: process.env.GEMINI_MODEL ?? 'gemini-flash-latest',
  answerProviderOverride: optional('ANSWER_PROVIDER'),

  voyageApiKey: optional('VOYAGE_API_KEY'),
  embeddingModel: process.env.EMBEDDING_MODEL ?? 'voyage-3',
  embeddingDim: Number(process.env.EMBEDDING_DIM ?? 1024),

  maxUploadBytes: Number(process.env.MAX_UPLOAD_MB ?? 25) * 1024 * 1024,
  askRateLimitPerHour: Number(process.env.ASK_RATE_LIMIT_PER_HOUR ?? 60),
  loginRateLimitPer15Min: Number(process.env.LOGIN_RATE_LIMIT_PER_15MIN ?? 10),
  demoRateLimitPerHour: Number(process.env.DEMO_RATE_LIMIT_PER_HOUR ?? 10),

  // Timeouts. The defaults suit hosted dependencies (Neon, Upstash), where a
  // round trip crosses the internet and a suspended database has to wake up
  // first. Local Postgres/Redis will simply never come close to them.
  dbConnectTimeoutMs: Number(process.env.DB_CONNECT_TIMEOUT_MS ?? 10_000),
  healthProbeTimeoutMs: Number(process.env.HEALTH_PROBE_TIMEOUT_MS ?? 8_000),
  redisCommandTimeoutMs: Number(process.env.REDIS_COMMAND_TIMEOUT_MS ?? 3_000),

  // Retrieval tuning (chunk sizing lives in services/chunker.js)
  retrieveTopK: 8,
  answerCacheTtlSeconds: 60 * 60 * 6,
};
