import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';

const SYSTEM_PROMPT = `You answer questions strictly from a set of numbered source excerpts taken from the user's own documents.

Rules you must follow:
- Use only the information in the excerpts. You have no other knowledge of these documents.
- Cite every factual claim with the bracketed number of the excerpt it came from, like [2]. A sentence drawing on two excerpts gets both, like [2][5].
- Never cite a number that does not appear in the excerpts you were given.
- If the excerpts do not contain the answer, say so plainly and name what is missing. Do not guess, and do not fill the gap from general knowledge.
- If the excerpts conflict, say so and cite both sides rather than silently picking one.

Keep answers focused and readable: lead with the direct answer, then the supporting detail. Write in complete sentences.`;

/** Renders retrieved chunks as the numbered excerpt list the prompt refers to. */
function buildContext(chunks) {
  return chunks
    .map((chunk, index) => {
      const pages =
        chunk.pageStart === chunk.pageEnd
          ? `page ${chunk.pageStart}`
          : `pages ${chunk.pageStart}-${chunk.pageEnd}`;
      return `[${index + 1}] (${chunk.filename}, ${pages})\n${chunk.content}`;
    })
    .join('\n\n');
}

function buildUserMessage(question, chunks) {
  return `Source excerpts:\n\n${buildContext(chunks)}\n\n---\n\nQuestion: ${question}`;
}

/**
 * Which provider answers. The retrieval side (Voyage embeddings + pgvector) is
 * identical either way — only the final "write a cited answer from these
 * excerpts" call differs, which is what makes the provider swappable at all.
 */
export function answerProvider() {
  const forced = config.answerProviderOverride;
  if (forced) {
    if (!['anthropic', 'gemini'].includes(forced)) {
      throw new Error(`ANSWER_PROVIDER must be "anthropic" or "gemini", got "${forced}"`);
    }
    return forced;
  }
  if (config.anthropicApiKey) return 'anthropic';
  if (config.geminiApiKey) return 'gemini';
  return null;
}

// ---------------------------------------------------------------------------
// Anthropic (Claude)
// ---------------------------------------------------------------------------

let anthropicClient;

function getAnthropicClient() {
  if (!anthropicClient) {
    if (!config.anthropicApiKey) {
      throw new Error('ANTHROPIC_API_KEY is not set — cannot use the anthropic provider');
    }
    anthropicClient = new Anthropic({ apiKey: config.anthropicApiKey });
  }
  return anthropicClient;
}

async function* streamAnthropic(userMessage) {
  const stream = getAnthropicClient().beta.messages.stream({
    model: config.answerModel,
    max_tokens: 8192,
    // Effort `low` keeps answering fast and cheap. Thinking stays on (the
    // default on this model) — disabling it is the more expensive lever and
    // brings its own failure modes.
    output_config: { effort: 'low' },
    // Safety classifiers can decline a request; `fallbacks: "default"` re-runs
    // it on Anthropic's recommended fallback model server-side instead of
    // handing the user a dead end.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
  });

  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      yield { type: 'token', text: event.delta.text };
    }
  }

  const message = await stream.finalMessage();

  // A refusal arrives as a normal successful response, not an error.
  if (message.stop_reason === 'refusal') {
    yield { type: 'refusal', category: message.stop_details?.category ?? null };
    return;
  }

  yield {
    type: 'done',
    usage: {
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
    },
    stopReason: message.stop_reason,
  };
}

// ---------------------------------------------------------------------------
// Google (Gemini)
// ---------------------------------------------------------------------------

/**
 * Gemini's streaming REST endpoint with alt=sse emits Server-Sent Events where
 * every `data:` line is a complete JSON GenerateContentResponse. Called via
 * fetch rather than an SDK — one endpoint does not justify a dependency, and
 * the Voyage client in embeddings.js already follows this pattern.
 */
async function* streamGemini(userMessage) {
  if (!config.geminiApiKey) {
    throw new Error('GEMINI_API_KEY is not set — cannot use the gemini provider');
  }

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `${config.geminiModel}:streamGenerateContent?alt=sse`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': config.geminiApiKey,
    },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts: [{ text: userMessage }] }],
      generationConfig: { maxOutputTokens: 8192 },
    }),
  });

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`Gemini request failed (${response.status}): ${detail}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let usage = null;
  let finishReason = null;

  // Each `data:` line carries one complete JSON GenerateContentResponse, so
  // parsing is line-by-line rather than frame-by-frame. Splitting on /\r?\n/
  // matters: Gemini terminates lines with \r\n, and an earlier version of this
  // parser split frames on "\n\n", never matched, and silently processed only
  // the first line of the entire response.
  const handleDataLine = (json) => {
    const payload = JSON.parse(json);
    const candidate = payload.candidates?.[0];

    if (payload.usageMetadata) {
      usage = {
        inputTokens: payload.usageMetadata.promptTokenCount ?? null,
        outputTokens: payload.usageMetadata.candidatesTokenCount ?? null,
      };
    }
    if (candidate?.finishReason) finishReason = candidate.finishReason;

    return (candidate?.content?.parts ?? [])
      // Thinking-enabled models mark reasoning parts with thought: true;
      // those are working notes, not answer text.
      .filter((part) => !part.thought)
      .map((part) => part.text ?? '')
      .join('');
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const text = handleDataLine(line.slice(6));
      if (text) yield { type: 'token', text };
    }
  }

  // A final line without a trailing newline is still a valid event.
  if (buffer.startsWith('data: ')) {
    const text = handleDataLine(buffer.slice(6));
    if (text) yield { type: 'token', text };
  }

  // Gemini signals a content block via finishReason rather than a status code.
  if (finishReason === 'SAFETY' || finishReason === 'PROHIBITED_CONTENT') {
    yield { type: 'refusal', category: finishReason.toLowerCase() };
    return;
  }

  yield { type: 'done', usage, stopReason: finishReason ?? 'stop' };
}

// ---------------------------------------------------------------------------

/**
 * Streams a cited answer.
 *
 * Yields `{type: 'token'}` events as text arrives, then exactly one terminal
 * event: `{type: 'done'}` on success or `{type: 'refusal'}` if the provider
 * declined the request. Callers must handle both.
 */
export async function* streamAnswer({ question, chunks }) {
  if (chunks.length === 0) {
    yield {
      type: 'token',
      text: "I couldn't find anything in your documents relevant to that question. Try rephrasing it, or upload the document that covers it.",
    };
    yield { type: 'done', usage: null, groundedIn: [] };
    return;
  }

  const provider = answerProvider();
  if (!provider) {
    throw new Error(
      'No answer provider configured — set GEMINI_API_KEY (free tier at aistudio.google.com) ' +
        'or ANTHROPIC_API_KEY (console.anthropic.com) in .env',
    );
  }

  const userMessage = buildUserMessage(question, chunks);

  if (provider === 'gemini') {
    yield* streamGemini(userMessage);
  } else {
    yield* streamAnthropic(userMessage);
  }
}
