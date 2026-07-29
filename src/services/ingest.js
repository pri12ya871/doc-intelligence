import fs from 'node:fs/promises';
import path from 'node:path';
import { query, withTransaction, toVectorLiteral } from '../db.js';
import { extractPages, chunkPages } from './chunker.js';
import { embedDocuments } from './embeddings.js';

export const UPLOAD_DIR = path.resolve('uploads');

export function storagePathFor(contentHash) {
  return path.join(UPLOAD_DIR, `${contentHash}.pdf`);
}

/**
 * Parse → chunk → embed → store, for one document.
 *
 * Chunks are inserted in batches inside a single transaction: a half-embedded
 * document that reports itself as 'ready' would silently answer questions from
 * partial evidence, which is worse than failing.
 */
export async function ingestDocument(documentId) {
  const { rows } = await query(
    'SELECT id, user_id, filename, content_hash, status FROM documents WHERE id = $1',
    [documentId],
  );
  const doc = rows[0];

  if (!doc) {
    throw new Error(`Document ${documentId} no longer exists`);
  }
  if (doc.status === 'ready') {
    return { skipped: true, reason: 'already ingested' };
  }

  await query(
    "UPDATE documents SET status = 'processing', error_message = NULL, updated_at = now() WHERE id = $1",
    [documentId],
  );

  try {
    const buffer = await fs.readFile(storagePathFor(doc.content_hash));

    const pages = await extractPages(buffer);
    if (pages.length === 0 || pages.every((p) => !p.trim())) {
      throw new Error(
        'No extractable text found. This looks like a scanned PDF — it needs OCR before it can be indexed.',
      );
    }

    const chunks = chunkPages(pages);
    const embeddings = await embedDocuments(chunks.map((c) => c.content));

    if (embeddings.length !== chunks.length) {
      throw new Error(
        `Embedding count mismatch: got ${embeddings.length} for ${chunks.length} chunks`,
      );
    }

    await withTransaction(async (client) => {
      // Re-ingest of a previously failed document should not double up.
      await client.query('DELETE FROM chunks WHERE document_id = $1', [documentId]);

      for (let i = 0; i < chunks.length; i += 1) {
        const chunk = chunks[i];
        await client.query(
          `INSERT INTO chunks
             (document_id, user_id, chunk_index, page_start, page_end, content, token_est, embedding)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            documentId,
            doc.user_id,
            chunk.chunkIndex,
            chunk.pageStart,
            chunk.pageEnd,
            chunk.content,
            chunk.tokenEst,
            toVectorLiteral(embeddings[i]),
          ],
        );
      }

      await client.query(
        `UPDATE documents
            SET status = 'ready', page_count = $2, chunk_count = $3, updated_at = now()
          WHERE id = $1`,
        [documentId, pages.length, chunks.length],
      );
    });

    return { pages: pages.length, chunks: chunks.length };
  } catch (err) {
    await query(
      "UPDATE documents SET status = 'failed', error_message = $2, updated_at = now() WHERE id = $1",
      [documentId, err.message.slice(0, 500)],
    );
    throw err;
  }
}
