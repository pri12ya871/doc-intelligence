import { Queue } from 'bullmq';
import { queueConnection, isLocalRedis } from '../redis.js';

export const INGEST_QUEUE = 'document-ingest';

export const ingestQueue = isLocalRedis
  ? null
  : new Queue(INGEST_QUEUE, { connection: queueConnection });

/**
 * Ingestion is queued rather than done inline because a 500-page PDF takes
 * minutes to parse and embed — far longer than an HTTP request should live.
 * The upload endpoint returns as soon as the row exists, and the client polls
 * document status.
 *
 * Without Redis there is no queue, so the work runs in this process instead.
 * The upload response is still immediate (the promise is deliberately not
 * awaited), but the tradeoffs of a real queue are gone: no retries, no
 * backoff, and the job dies with the process. Local convenience only.
 */
export async function enqueueIngest(documentId) {
  if (isLocalRedis) {
    const { ingestDocument } = await import('./ingest.js');

    setImmediate(() => {
      ingestDocument(documentId).catch((err) => {
        // ingestDocument already records the failure on the document row; this
        // just keeps the rejection from going unhandled.
        console.error(`[ingest:inline] document ${documentId} failed: ${err.message}`);
      });
    });

    return { inline: true };
  }

  return ingestQueue.add(
    'ingest',
    { documentId },
    {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: 100,
      removeOnFail: 500,
    },
  );
}
