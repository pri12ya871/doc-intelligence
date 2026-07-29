import { config } from '../config.js';

const VOYAGE_URL = 'https://api.voyageai.com/v1/embeddings';
const MAX_BATCH = 128;

/**
 * Anthropic does not serve an embeddings endpoint — Voyage is the provider they
 * recommend, so retrieval runs on Voyage and generation runs on Claude.
 *
 * `inputType` genuinely matters for retrieval quality: Voyage encodes documents
 * and queries into the same space but with different prefixes, and using
 * 'document' for both measurably degrades recall.
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Voyage's free tier allows only 3 requests per minute, and a document of any
 * size needs several. Without backoff, ingesting a real PDF fails partway
 * through and leaves the document marked failed for a reason that would have
 * resolved by simply waiting.
 *
 * Retries 429 and 5xx; a 401 or a malformed request is returned immediately,
 * since repeating it cannot help.
 */
async function requestWithRetry(body, { attempts = 5 } = {}) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await fetch(VOYAGE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.voyageApiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (response.ok) return response;

    const detail = (await response.text()).slice(0, 300);
    const retryable = response.status === 429 || response.status >= 500;

    if (!retryable || attempt === attempts) {
      throw new Error(`Voyage embeddings failed (${response.status}): ${detail}`);
    }

    // Honour Retry-After when present; otherwise back off exponentially from
    // 20s, which clears a 3-per-minute window.
    const retryAfter = Number(response.headers.get('retry-after'));
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : Math.min(20_000 * 2 ** (attempt - 1), 60_000);

    console.warn(
      `[embeddings] HTTP ${response.status} from Voyage; retrying in ${Math.round(waitMs / 1000)}s ` +
        `(attempt ${attempt}/${attempts})`,
    );
    lastError = detail;
    await sleep(waitMs);
  }

  throw new Error(`Voyage embeddings failed after ${attempts} attempts: ${lastError}`);
}

async function embedBatch(texts, inputType) {
  if (!config.voyageApiKey) {
    throw new Error('VOYAGE_API_KEY is not set — cannot generate embeddings');
  }

  const response = await requestWithRetry({
    model: config.embeddingModel,
    input: texts,
    input_type: inputType,
  });

  const json = await response.json();
  // Voyage returns results with an explicit index; sort rather than assuming
  // response order matches request order.
  return json.data
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((item) => item.embedding);
}

/** Embeds document chunks, batching to stay under Voyage's per-request cap. */
export async function embedDocuments(texts) {
  const out = [];
  for (let i = 0; i < texts.length; i += MAX_BATCH) {
    const batch = texts.slice(i, i + MAX_BATCH);
    out.push(...(await embedBatch(batch, 'document')));
  }
  return out;
}

export async function embedQuery(text) {
  const [embedding] = await embedBatch([text], 'query');
  return embedding;
}
