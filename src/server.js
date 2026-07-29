import express from 'express';
import path from 'node:path';
import { config } from './config.js';
import { query, closeDb, describeDatabase, isLocalDb } from './db.js';
import { cache, closeRedis, describeCache, isLocalRedis } from './redis.js';
import { describeError, isConnectionError } from './util/errors.js';
import { authRouter } from './routes/auth.js';
import { documentsRouter } from './routes/documents.js';
import { chatRouter } from './routes/chat.js';

const app = express();

// Rate limiting keys off req.ip, which is only meaningful behind a proxy when
// Express is told to trust the forwarded header.
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.resolve('public')));

/**
 * A health check that can hang is worse than no health check — a load balancer
 * waits on it instead of marking the instance unhealthy. Every probe gets a
 * hard deadline regardless of how the underlying client behaves.
 */
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms).unref(),
    ),
  ]);
}

app.get('/health', async (_req, res) => {
  const health = { status: 'ok', postgres: 'unknown', redis: 'unknown' };

  // The deadline has to exceed a serverless database's cold start, or a healthy
  // instance waking from idle gets reported as degraded.
  const probeMs = config.healthProbeTimeoutMs;
  const [postgres, redisStatus] = await Promise.allSettled([
    withTimeout(query('SELECT 1'), probeMs, 'postgres'),
    withTimeout(cache.ping(), probeMs, 'redis'),
  ]);

  if (postgres.status === 'fulfilled') {
    health.postgres = 'ok';
  } else {
    health.postgres = `error: ${describeError(postgres.reason)}`;
    health.status = 'degraded';
  }

  if (redisStatus.status === 'fulfilled') {
    health.redis = 'ok';
  } else {
    health.redis = `error: ${describeError(redisStatus.reason)}`;
    health.status = 'degraded';
  }

  res.status(health.status === 'ok' ? 200 : 503).json(health);
});

app.use('/api/auth', authRouter);
app.use('/api/documents', documentsRouter);
app.use('/api/chat', chatRouter);

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity
app.use((err, _req, res, _next) => {
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      error: `File too large (limit ${Math.round(config.maxUploadBytes / 1024 / 1024)} MB)`,
    });
  }
  if (err.message === 'Only PDF uploads are supported') {
    return res.status(415).json({ error: err.message });
  }

  // Missing infrastructure is the single most common cause of a failed request
  // in local development. Say so, instead of making the reader suspect a bug in
  // their own code.
  if (isConnectionError(err)) {
    console.error('[error] dependency unreachable:', describeError(err));
    return res.status(503).json({
      error: 'Database unavailable — the API cannot reach Postgres.',
      hint: 'Start the dependencies with "docker compose up", or point DATABASE_URL at a running Postgres that has the pgvector extension.',
      detail: config.nodeEnv === 'production' ? undefined : describeError(err),
    });
  }

  console.error('[error]', err);
  res.status(500).json({
    error: 'Internal server error',
    // Detail is withheld in production so internal failures aren't leaked to
    // callers, but it must actually be useful in development.
    detail: config.nodeEnv === 'production' ? undefined : describeError(err),
  });
});

const server = app.listen(config.port, async () => {
  console.log(`[server] listening on http://localhost:${config.port}`);
  console.log(`[server] database: ${await describeDatabase()}`);
  console.log(`[server] cache:    ${describeCache()}`);

  if (isLocalDb || isLocalRedis) {
    console.log(
      '[server] running in LOCAL MODE — data stays on this machine and ingestion is in-process.',
    );
    console.log(
      '[server] set DATABASE_URL and REDIS_URL in .env to use a real Postgres and Redis.',
    );
  }
});

async function shutdown() {
  console.log('[server] shutting down');
  server.close();
  await closeDb();
  await closeRedis();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
