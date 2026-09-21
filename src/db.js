import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { config } from './config.js';

/**
 * Two drivers behind one interface.
 *
 * When DATABASE_URL is set, this talks to a real Postgres server (Neon, or a
 * local/containerised one) through node-postgres. When it isn't, it falls back
 * to PGlite — the actual PostgreSQL engine compiled to WebAssembly, running
 * in-process against a directory on disk.
 *
 * The fallback exists so the app is runnable with nothing installed and no
 * accounts created. It is genuinely Postgres with genuine pgvector, so the SQL
 * in this project is identical either way — but it is single-process and local,
 * so it is a development convenience, not a deployment target.
 */
export const isLocalDb = !config.databaseUrl;

export const LOCAL_DB_DIR = path.resolve('data/pgdata');

let driver = null;
let initPromise = null;

function sslFor(url) {
  if (/[?&]sslmode=/.test(url)) return undefined;
  const isLocal = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url);
  if (isLocal) return false;
  // Managed providers present certificates from real authorities, so the chain
  // is verified rather than blindly accepted.
  return { rejectUnauthorized: true };
}

async function createDriver() {
  if (isLocalDb) {
    // Imported lazily so deployments using a real Postgres never load the WASM
    // build at all.
    const { PGlite } = await import('@electric-sql/pglite');
    const { vector } = await import('@electric-sql/pglite-pgvector');

    // PGlite creates its own data directory but not the parents above it.
    fs.mkdirSync(path.dirname(LOCAL_DB_DIR), { recursive: true });

    const db = await PGlite.create(LOCAL_DB_DIR, { extensions: { vector } });

    return {
      kind: 'pglite',
      description: `PGlite (embedded Postgres) at ${path.relative(process.cwd(), LOCAL_DB_DIR)}`,
      // PGlite reports affectedRows; callers are written against pg's rowCount.
      query: async (text, params) => {
        const result = await db.query(text, params);
        return { ...result, rowCount: result.affectedRows ?? result.rows.length };
      },
      exec: (sql) => db.exec(sql),
      transaction: (fn) => db.transaction((tx) => fn({ query: (t, p) => tx.query(t, p) })),
      close: () => db.close(),
    };
  }

  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    ssl: sslFor(config.databaseUrl),
    max: 10,
    idleTimeoutMillis: 30_000,
    // Serverless Postgres suspends when idle and takes a few seconds to wake,
    // so the first connection after a quiet period needs room.
    connectionTimeoutMillis: config.dbConnectTimeoutMs,
  });

  return {
    kind: 'postgres',
    description: `Postgres at ${new URL(config.databaseUrl).hostname}`,
    query: (text, params) => pool.query(text, params),
    exec: (sql) => pool.query(sql),
    transaction: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

/** Initialises the driver once, even under concurrent first calls. */
function getDriver() {
  if (driver) return Promise.resolve(driver);
  initPromise ??= createDriver().then((created) => {
    driver = created;
    return created;
  });
  return initPromise;
}

export async function query(text, params) {
  return (await getDriver()).query(text, params);
}

/** Runs multi-statement SQL, such as the schema file. */
export async function exec(sql) {
  return (await getDriver()).exec(sql);
}

/** Runs `fn` inside a transaction, rolling back on any throw. */
export async function withTransaction(fn) {
  return (await getDriver()).transaction(fn);
}

export async function describeDatabase() {
  return (await getDriver()).description;
}

export async function closeDb() {
  if (driver) {
    await driver.close();
    driver = null;
    initPromise = null;
  }
}

/** pgvector's text input format: '[0.1,0.2,...]' */
export function toVectorLiteral(embedding) {
  return `[${embedding.join(',')}]`;
}
