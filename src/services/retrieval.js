import { query, toVectorLiteral } from '../db.js';
import { embedQuery } from './embeddings.js';
import { config } from '../config.js';

/**
 * Semantic search over one user's chunks.
 *
 * The `user_id = $2` predicate is the tenant boundary — it is applied in SQL
 * rather than filtered in application code so there is no path where a caller
 * can see another user's document, whatever the vector index returns.
 *
 * `<=>` is pgvector's cosine distance (0 = identical), so similarity is 1 - d.
 */
export async function retrieveChunks({ userId, question, documentId = null, topK = config.retrieveTopK }) {
  const embedding = await embedQuery(question);
  const vector = toVectorLiteral(embedding);

  const { rows } = await query(
    `SELECT c.id,
            c.document_id,
            c.content,
            c.page_start,
            c.page_end,
            d.filename,
            1 - (c.embedding <=> $1::vector) AS similarity
       FROM chunks c
       JOIN documents d ON d.id = c.document_id
      WHERE c.user_id = $2
        AND d.status = 'ready'
        AND ($3::bigint IS NULL OR c.document_id = $3)
      ORDER BY c.embedding <=> $1::vector
      LIMIT $4`,
    [vector, userId, documentId, topK],
  );

  return rows.map((row) => ({
    id: Number(row.id),
    documentId: Number(row.document_id),
    filename: row.filename,
    content: row.content,
    pageStart: row.page_start,
    pageEnd: row.page_end,
    similarity: Number(row.similarity),
  }));
}
