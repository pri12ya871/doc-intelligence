import IORedis from 'ioredis';
import { config } from './config.js';
import { describeError } from './util/errors.js';

/**
 * When REDIS_URL is unset the app runs without Redis: the answer cache and rate
 * limiter fall back to process memory, and ingestion runs in-process instead of
 * through a queue (see services/queue.js).
 *
 * That is fine for one developer on one machine and wrong for anything else —
 * memory is not shared between processes, so with more than one instance the
 * rate limit becomes per-instance and the cache stops being shared.
 */
export const isLocalRedis = !config.redisUrl;

/**
 * Minimal in-memory stand-in covering only the commands this app issues.
 * Expiry is checked lazily on read, so there is no timer to leak.
 */
function createMemoryCache() {
  const store = new Map(); // key -> { value, expiresAt|null }

  const live = (key) => {
    const entry = store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      store.delete(key);
      return null;
    }
    return entry;
  };

  return {
    isMemory: true,
    async ping() {
      return 'PONG';
    },
    async get(key) {
      return live(key)?.value ?? null;
    },
    async set(key, value, mode, seconds) {
      const expiresAt = mode === 'EX' ? Date.now() + seconds * 1000 : null;
      store.set(key, { value, expiresAt });
      return 'OK';
    },
    async incr(key) {
      const entry = live(key);
      const next = String(Number(entry?.value ?? 0) + 1);
      store.set(key, { value: next, expiresAt: entry?.expiresAt ?? null });
      return Number(next);
    },
    async expire(key, seconds) {
      const entry = live(key);
      if (!entry) return 0;
      entry.expiresAt = Date.now() + seconds * 1000;
      return 1;
    },
    async ttl(key) {
      const entry = live(key);
      if (!entry) return -2;
      if (entry.expiresAt === null) return -1;
      return Math.max(0, Math.ceil((entry.expiresAt - Date.now()) / 1000));
    },
    async quit() {
      store.clear();
      return 'OK';
    },
  };
}

function createRealClients() {
  /**
   * Two connections, because the two workloads need opposite failure behaviour.
   *
   * The queue connection is for BullMQ, which issues blocking commands that
   * legitimately sit open for a long time — it must have no command timeout.
   *
   * The cache connection serves HTTP requests, so a dead Redis has to surface
   * as a fast error rather than an indefinite wait.
   */
  const queue = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });

  const cacheClient = new IORedis(config.redisUrl, {
    commandTimeout: config.redisCommandTimeoutMs,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    retryStrategy: (times) => Math.min(times * 200, 5000),
  });

  for (const [name, client] of [
    ['queue', queue],
    ['cache', cacheClient],
  ]) {
    client.on('error', (err) => {
      // Logged, not thrown: an unhandled 'error' event would crash the process
      // every time Redis blips.
      console.error(`[redis:${name}] ${describeError(err)}`);
    });
  }

  return { queue, cacheClient };
}

const clients = isLocalRedis ? null : createRealClients();

export const queueConnection = clients?.queue ?? null;
export const cache = clients?.cacheClient ?? createMemoryCache();

export function describeCache() {
  return isLocalRedis
    ? 'in-memory (no REDIS_URL set)'
    : `Redis at ${new URL(config.redisUrl).hostname}`;
}

export async function closeRedis() {
  if (clients) {
    await Promise.allSettled([clients.queue.quit(), clients.cacheClient.quit()]);
  }
}
