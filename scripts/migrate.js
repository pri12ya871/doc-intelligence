import fs from 'node:fs/promises';
import path from 'node:path';
import { exec, closeDb, describeDatabase } from '../src/db.js';
import { config } from '../src/config.js';

/**
 * Applies db/schema.sql. Every statement is CREATE ... IF NOT EXISTS, so this
 * is safe to run repeatedly (including on container start).
 */
async function migrate() {
  const schemaPath = path.resolve('db/schema.sql');
  let sql = await fs.readFile(schemaPath, 'utf8');

  // Keep the vector column width in sync with the configured embedding model.
  if (config.embeddingDim !== 1024) {
    sql = sql.replaceAll('vector(1024)', `vector(${config.embeddingDim})`);
  }

  console.log(`[migrate] target: ${await describeDatabase()}`);
  await exec(sql);
  console.log('[migrate] schema applied');
  await closeDb();
}

migrate().catch((err) => {
  console.error('[migrate] failed:', err.message);
  process.exit(1);
});
