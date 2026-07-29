import crypto from 'node:crypto';
import express from 'express';
import { query } from '../db.js';
import { cache } from '../redis.js';
import { config } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { rateLimit, userKey } from '../middleware/rateLimit.js';
import { retrieveChunks } from '../services/retrieval.js';
import { streamAnswer } from '../services/answer.js';

export const chatRouter = express.Router();

chatRouter.use(requireAuth);

const askLimiter = rateLimit({
  name: 'ask',
  limit: config.askRateLimitPerHour,
  windowSeconds: 60 * 60,
  keyFn: userKey,
});

/**
 * Cache key covers the user, the document scope, and the normalized question.
 * The user id is part of the key because the same question over different
 * users' documents has different correct answers.
 */
function cacheKey(userId, documentId, question) {
  const normalized = question.trim().toLowerCase().replace(/\s+/g, ' ');
  const digest = crypto
    .createHash('sha256')
    .update(`${userId}|${documentId ?? 'all'}|${normalized}`)
    .digest('hex');
  return `answer:${digest}`;
}

function sseSetup(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
}

function sseSend(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

chatRouter.post('/ask', askLimiter, async (req, res) => {
  const startedAt = Date.now();
  const question = String(req.body?.question ?? '').trim();
  const documentId = req.body?.document_id ? Number(req.body.document_id) : null;

  if (question.length < 3) {
    return res.status(400).json({ error: 'Question must be at least 3 characters' });
  }
  if (question.length > 2000) {
    return res.status(400).json({ error: 'Question is too long (max 2000 characters)' });
  }

  if (documentId !== null) {
    const owned = await query('SELECT 1 FROM documents WHERE id = $1 AND user_id = $2', [
      documentId,
      req.user.id,
    ]);
    if (owned.rowCount === 0) {
      return res.status(404).json({ error: 'Document not found' });
    }
  }

  const key = cacheKey(req.user.id, documentId, question);

  try {
    const cached = await cache.get(key);
    if (cached) {
      const payload = JSON.parse(cached);
      sseSetup(res);
      sseSend(res, 'sources', { sources: payload.sources, cached: true });
      sseSend(res, 'token', { text: payload.answer });
      sseSend(res, 'done', { cached: true, usage: null });
      res.end();

      await query(
        'INSERT INTO query_log (user_id, document_id, question, cache_hit, latency_ms) VALUES ($1, $2, $3, true, $4)',
        [req.user.id, documentId, question, Date.now() - startedAt],
      );
      return;
    }
  } catch (err) {
    // A cache miss and a broken cache should look the same to the caller.
    console.error('[chat] cache read failed:', err.message);
  }

  let chunks;
  try {
    chunks = await retrieveChunks({ userId: req.user.id, question, documentId });
  } catch (err) {
    console.error('[chat] retrieval failed:', err.message);
    return res.status(502).json({ error: 'Retrieval failed', detail: err.message });
  }

  const sources = chunks.map((chunk, index) => ({
    marker: index + 1,
    document_id: chunk.documentId,
    filename: chunk.filename,
    page_start: chunk.pageStart,
    page_end: chunk.pageEnd,
    similarity: Number(chunk.similarity.toFixed(4)),
    excerpt: chunk.content.slice(0, 320),
  }));

  sseSetup(res);
  sseSend(res, 'sources', { sources, cached: false });

  // If the client hangs up mid-answer, stop generating.
  let aborted = false;
  req.on('close', () => {
    aborted = true;
  });

  let answer = '';
  let usage = null;

  try {
    for await (const event of streamAnswer({ question, chunks })) {
      if (aborted) break;

      if (event.type === 'token') {
        answer += event.text;
        sseSend(res, 'token', { text: event.text });
      } else if (event.type === 'refusal') {
        sseSend(res, 'refusal', {
          message:
            'The model declined to answer this request. Rephrasing the question usually resolves it.',
          category: event.category,
        });
      } else if (event.type === 'done') {
        usage = event.usage;
        sseSend(res, 'done', { cached: false, usage });
      }
    }
  } catch (err) {
    console.error('[chat] generation failed:', err.message);
    sseSend(res, 'error', { message: 'Answer generation failed', detail: err.message });
  } finally {
    res.end();
  }

  if (!aborted && answer) {
    try {
      await cache.set(key, JSON.stringify({ answer, sources }), 'EX', config.answerCacheTtlSeconds);
    } catch (err) {
      console.error('[chat] cache write failed:', err.message);
    }
  }

  try {
    await query(
      `INSERT INTO query_log (user_id, document_id, question, cache_hit, input_tokens, output_tokens, latency_ms)
       VALUES ($1, $2, $3, false, $4, $5, $6)`,
      [
        req.user.id,
        documentId,
        question,
        usage?.inputTokens ?? null,
        usage?.outputTokens ?? null,
        Date.now() - startedAt,
      ],
    );
  } catch (err) {
    console.error('[chat] query log failed:', err.message);
  }
});

chatRouter.get('/history', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT question, document_id, cache_hit, input_tokens, output_tokens, latency_ms, created_at
         FROM query_log
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT 50`,
      [req.user.id],
    );
    res.json({ history: rows });
  } catch (err) {
    next(err);
  }
});
