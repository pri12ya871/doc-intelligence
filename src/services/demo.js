import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { query, withTransaction } from '../db.js';
import { UPLOAD_DIR, storagePathFor, ingestDocument } from './ingest.js';

/**
 * One-click demo accounts, so a visitor can try the app without signing up.
 *
 * Each visitor gets a private account rather than a shared one: a shared demo
 * login would show every visitor's uploads to every other visitor. The sample
 * document is embedded once into a template account and copied row-for-row
 * into each new demo account, so a demo costs no embedding calls.
 */

export const SAMPLE_PATH = path.resolve('samples/doc-intelligence-design-notes.pdf');
const SAMPLE_FILENAME = 'doc-intelligence-design-notes.pdf';

// `.invalid` is reserved (RFC 2606), so these can never collide with a real address.
const TEMPLATE_EMAIL = 'demo-template@demo.invalid';
const DEMO_EMAIL_PATTERN = 'demo-%@demo.invalid';

// Tokens expire before the account is deleted, so a live session never points
// at a user that no longer exists.
export const DEMO_TOKEN_TTL = '1d';
const DEMO_RETENTION = '2 days';

/** Nobody knows this password, so the account is reachable only through its token. */
async function unusablePasswordHash() {
  return bcrypt.hash(crypto.randomBytes(32).toString('hex'), 4);
}

let templatePromise = null;

/**
 * Returns the template's ready sample document, ingesting it on first use.
 * Memoised so concurrent first clicks share one ingestion instead of racing;
 * a failure clears the memo so the next click retries.
 */
function ensureTemplateDocument() {
  templatePromise ??= loadOrIngestTemplate().catch((err) => {
    templatePromise = null;
    throw err;
  });
  return templatePromise;
}

async function loadOrIngestTemplate() {
  const buffer = await fs.readFile(SAMPLE_PATH);
  const contentHash = crypto.createHash('sha256').update(buffer).digest('hex');

  const { rows: users } = await query(
    `INSERT INTO users (email, password_hash) VALUES ($1, $2)
     ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
     RETURNING id`,
    [TEMPLATE_EMAIL, await unusablePasswordHash()],
  );
  const templateUserId = users[0].id;

  const { rows: docs } = await query(
    `INSERT INTO documents (user_id, filename, content_hash, size_bytes)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, content_hash) DO UPDATE SET filename = EXCLUDED.filename
     RETURNING id, status`,
    [templateUserId, SAMPLE_FILENAME, contentHash, buffer.length],
  );
  const doc = docs[0];

  if (doc.status !== 'ready') {
    // Upload storage is ephemeral on the free tier, so write the file every
    // time ingestion is needed rather than trusting an earlier copy survived.
    await fs.mkdir(UPLOAD_DIR, { recursive: true });
    await fs.writeFile(storagePathFor(contentHash), buffer);
    await ingestDocument(doc.id);
  }

  return doc.id;
}

/** Deletes demo accounts past retention; their documents and chunks cascade. */
async function pruneExpiredDemoUsers() {
  await query(
    `DELETE FROM users
      WHERE email LIKE $1 AND email <> $2
        AND created_at < now() - $3::interval`,
    [DEMO_EMAIL_PATTERN, TEMPLATE_EMAIL, DEMO_RETENTION],
  );
}

export async function createDemoUser() {
  pruneExpiredDemoUsers().catch((err) => {
    console.error('[demo] pruning expired demo users failed:', err.message);
  });

  const email = `demo-${crypto.randomBytes(8).toString('hex')}@demo.invalid`;

  const { rows } = await query(
    'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email',
    [email, await unusablePasswordHash()],
  );
  const user = rows[0];

  // A demo without the sample is still a usable account, so a failure here
  // (say, the embedding API being down) degrades rather than blocks sign-in.
  let sampleReady = false;
  try {
    const templateDocId = await ensureTemplateDocument();
    await copyDocument(templateDocId, user.id);
    sampleReady = true;
  } catch (err) {
    console.error('[demo] could not provide the sample document:', err.message);
  }

  return { user, sampleReady };
}

/** Copies a ready document and its embedded chunks into another account. */
async function copyDocument(documentId, toUserId) {
  await withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO documents
         (user_id, filename, content_hash, size_bytes, page_count, status, chunk_count)
       SELECT $2, filename, content_hash, size_bytes, page_count, status, chunk_count
         FROM documents
        WHERE id = $1 AND status = 'ready'
       RETURNING id`,
      [documentId, toUserId],
    );
    if (rows.length === 0) throw new Error('Template document is not ready');

    await client.query(
      `INSERT INTO chunks
         (document_id, user_id, chunk_index, page_start, page_end, content, token_est, embedding)
       SELECT $2, $3, chunk_index, page_start, page_end, content, token_est, embedding
         FROM chunks
        WHERE document_id = $1`,
      [documentId, rows[0].id, toUserId],
    );
  });
}
