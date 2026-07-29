import { Worker } from 'bullmq';
import { queueConnection, closeRedis, isLocalRedis } from './redis.js';
import { INGEST_QUEUE } from './services/queue.js';
import { ingestDocument } from './services/ingest.js';
import { closeDb } from './db.js';

// Without Redis there is no queue to consume — the API ingests in-process, so a
// separate worker would sit idle forever. Say so instead of pretending to work.
if (isLocalRedis) {
  console.log('[worker] REDIS_URL is not set, so ingestion runs inside the API process.');
  console.log('[worker] Nothing for this worker to do — exiting. Just run "npm start".');
  process.exit(0);
}

// Concurrency of 2: ingestion is dominated by waiting on the embedding API, so
// a little parallelism helps, but every concurrent job holds a full PDF's
// worth of text in memory.
const worker = new Worker(
  INGEST_QUEUE,
  async (job) => {
    const { documentId } = job.data;
    console.log(`[worker] ingesting document ${documentId} (attempt ${job.attemptsMade + 1})`);
    const result = await ingestDocument(documentId);
    console.log(`[worker] document ${documentId} done:`, result);
    return result;
  },
  { connection: queueConnection, concurrency: 2 },
);

worker.on('failed', (job, err) => {
  console.error(`[worker] job ${job?.id} failed:`, err.message);
});

async function shutdown() {
  console.log('[worker] shutting down');
  await worker.close();
  await closeDb();
  await closeRedis();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

console.log('[worker] listening for ingestion jobs');
