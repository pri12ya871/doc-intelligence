/**
 * Checks that everything the app needs is actually reachable, and says exactly
 * what to fix when it isn't. Run this after editing .env, before blaming the
 * application code.
 *
 *   npm run doctor
 */
import { query, closeDb, describeDatabase, isLocalDb } from '../src/db.js';
import { cache, closeRedis, describeCache, isLocalRedis } from '../src/redis.js';
import { config } from '../src/config.js';
import { describeError } from '../src/util/errors.js';

const results = [];

function record(name, ok, detail, fix) {
  results.push({ name, ok });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok && fix) console.log(`       fix: ${fix}`);
}

async function checkDatabase() {
  try {
    console.log(`       using: ${await describeDatabase()}`);
    const { rows } = await query('SELECT version()');
    record('Database reachable', true, rows[0].version.split(',')[0]);
  } catch (err) {
    record(
      'Database reachable',
      false,
      describeError(err),
      isLocalDb
        ? 'The embedded database failed to start. Delete the data/pgdata folder and retry.'
        : 'Check DATABASE_URL in .env. For Neon, use the pooled connection string and keep ?sslmode=require.',
    );
    return;
  }

  try {
    const { rows } = await query(
      "SELECT default_version, installed_version FROM pg_available_extensions WHERE name = 'vector'",
    );
    if (rows.length === 0) {
      record(
        'pgvector available',
        false,
        'the "vector" extension is not offered by this server',
        'Use a Postgres that ships pgvector (Neon, Supabase, or the pgvector/pgvector Docker image).',
      );
      return;
    }
    record(
      'pgvector available',
      true,
      rows[0].installed_version
        ? `installed ${rows[0].installed_version}`
        : `available ${rows[0].default_version}, not yet installed`,
    );
  } catch (err) {
    record('pgvector available', false, describeError(err));
    return;
  }

  try {
    const { rows } = await query(
      "SELECT to_regclass('public.users') AS users, to_regclass('public.chunks') AS chunks",
    );
    const migrated = Boolean(rows[0].users && rows[0].chunks);
    record(
      'Schema applied',
      migrated,
      migrated ? 'users and chunks tables present' : 'tables missing',
      migrated ? undefined : 'Run: npm run migrate',
    );
  } catch (err) {
    record('Schema applied', false, describeError(err), 'Run: npm run migrate');
  }
}

async function checkCache() {
  console.log(`       using: ${describeCache()}`);

  try {
    await cache.ping();
    record('Cache reachable', true, isLocalRedis ? 'in-process memory' : 'responded to PING');
  } catch (err) {
    record(
      'Cache reachable',
      false,
      describeError(err),
      'Check REDIS_URL. Upstash requires the rediss:// TCP URL — the REST/HTTPS endpoint will not work.',
    );
    return;
  }

  if (isLocalRedis) {
    // There is no queue in this mode, so there is nothing to check.
    record(
      'Job queue',
      true,
      'ingestion runs in-process (no Redis configured)',
    );
    return;
  }

  try {
    const answer = await cache.eval("return 'ok'", 0);
    record('Job queue (Redis scripting)', answer === 'ok');
  } catch (err) {
    record(
      'Job queue (Redis scripting)',
      false,
      describeError(err),
      'This Redis blocks EVAL, so BullMQ cannot run. Use a standard Redis endpoint.',
    );
  }
}

function checkKeys() {
  record(
    'VOYAGE_API_KEY set',
    Boolean(config.voyageApiKey),
    undefined,
    'Required to index documents and to search. Get one at voyageai.com.',
  );

  const provider = config.anthropicApiKey
    ? 'anthropic (Claude)'
    : config.geminiApiKey
      ? 'gemini (free tier)'
      : null;
  record(
    'Answer provider key set',
    Boolean(provider),
    provider ? `using ${provider}` : 'neither ANTHROPIC_API_KEY nor GEMINI_API_KEY is set',
    'Required to answer questions. GEMINI_API_KEY has a free tier (aistudio.google.com); ANTHROPIC_API_KEY is paid (console.anthropic.com). Either works.',
  );
}

console.log('Checking dependencies…\n');
await checkDatabase();
await checkCache();
checkKeys();

const failures = results.filter((r) => !r.ok);

if (failures.length === 0) {
  console.log('\nAll checks passed.');
  console.log(
    isLocalRedis
      ? 'Start the app with "npm start" — no separate worker needed in local mode.'
      : 'Start the app with "npm start" and "npm run worker".',
  );
} else {
  console.log(`\n${failures.length} check(s) need attention (listed above).`);
}

await closeDb();
await closeRedis();
process.exit(failures.length === 0 ? 0 : 1);
