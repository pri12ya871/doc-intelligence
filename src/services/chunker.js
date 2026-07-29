import { extractText, getDocumentProxy } from 'unpdf';

// Chunking defaults live here rather than in config.js so this module stays
// pure — it can be unit-tested without a database URL or any other env setup.
export const DEFAULT_TARGET_TOKENS = 400;
export const DEFAULT_OVERLAP_TOKENS = 60;

/** ~4 characters per token is close enough for chunk sizing. */
export function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

/**
 * Extracts text per page. Page numbers are what make citations checkable, so
 * the text is never flattened into one blob — each page stays addressable.
 *
 * Uses unpdf (a current pdf.js build) rather than pdf-parse. pdf-parse bundles
 * a 2018 pdf.js that throws "bad XRef entry" on perfectly valid PDFs once
 * PGlite's WebAssembly runtime has initialised in the same process — the two
 * cannot coexist, and local mode needs both.
 */
export async function extractPages(buffer) {
  // getDocumentProxy wants a Uint8Array and takes ownership of the memory, so
  // hand it a copy rather than a view onto the caller's Buffer.
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { text } = await extractText(pdf, { mergePages: false });

  return text.map((page) => page.replace(/\s+/g, ' ').trim());
}

/**
 * Splits pages into overlapping chunks that never straddle a sentence boundary
 * mid-word, tracking which pages each chunk came from.
 *
 * The overlap matters: a fact that happens to sit on a chunk boundary is
 * otherwise retrievable by neither neighbour, because half its context is
 * missing from each.
 */
export function chunkPages(pages, {
  targetTokens = DEFAULT_TARGET_TOKENS,
  overlapTokens = DEFAULT_OVERLAP_TOKENS,
} = {}) {
  const chunks = [];

  // Chunks never span pages. A chunk covering pages 1-3 can only ever produce
  // the citation "pages 1-3", which is no better than citing the whole
  // document — the reader still has to search for the claim. Keeping each
  // chunk inside one page means every citation points at a single page the
  // reader can open and check. The cost is that a sentence straddling a page
  // break gets split, which matters far less than losing citation precision.
  pages.forEach((pageText, pageIndex) => {
    const page = pageIndex + 1;
    if (!pageText?.trim()) return;

    // Sentence-ish split. Keeps the terminator attached to its sentence.
    const sentences = (pageText.match(/[^.!?]+[.!?]+|\S[^.!?]*$/g) ?? [pageText])
      .map((s) => s.trim())
      .filter(Boolean);

    let current = [];
    let currentTokens = 0;

    const push = (sentences_) => {
      const text = sentences_.join(' ');
      chunks.push({
        chunkIndex: chunks.length,
        content: text,
        pageStart: page,
        pageEnd: page,
        tokenEst: estimateTokens(text),
      });
    };

    const flush = () => {
      if (current.length === 0) return;
      push(current);

      // Carry the tail of this chunk into the next as overlap, so a fact
      // sitting on a chunk boundary stays retrievable from both sides.
      const carry = [];
      let carryTokens = 0;
      for (let i = current.length - 1; i >= 0; i -= 1) {
        const tokens = estimateTokens(current[i]);
        if (carryTokens + tokens > overlapTokens) break;
        carry.unshift(current[i]);
        carryTokens += tokens;
      }
      current = carry;
      currentTokens = carryTokens;
    };

    for (const sentence of sentences) {
      const tokens = estimateTokens(sentence);

      // A single sentence longer than the target becomes its own chunk rather
      // than being silently truncated.
      if (tokens > targetTokens) {
        flush();
        if (current.length > 0) chunks.pop(); // drop the overlap-only remainder
        push([sentence]);
        current = [];
        currentTokens = 0;
        continue;
      }

      if (currentTokens + tokens > targetTokens) flush();

      current.push(sentence);
      currentTokens += tokens;
    }

    // Whatever remains is a real chunk unless it is purely carried-over
    // overlap already present at the end of the previous chunk.
    if (current.length > 0) {
      const text = current.join(' ');
      const previous = chunks[chunks.length - 1];
      const isOverlapOnly =
        previous && previous.pageStart === page && previous.content.endsWith(text);
      if (!isOverlapOnly) push(current);
    }
  });

  // chunkIndex is assigned in creation order above; renumber defensively in
  // case a branch popped a chunk.
  return chunks.map((chunk, index) => ({ ...chunk, chunkIndex: index }));
}
