import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkPages, estimateTokens } from '../src/services/chunker.js';

function makePage(sentenceCount, marker) {
  return Array.from(
    { length: sentenceCount },
    (_, i) => `This is sentence ${i} on ${marker} and it carries some filler text.`,
  ).join(' ');
}

test('keeps chunks under the target size', () => {
  const chunks = chunkPages([makePage(60, 'page one')], { targetTokens: 100, overlapTokens: 20 });

  assert.ok(chunks.length > 1, 'a long page should produce multiple chunks');
  for (const chunk of chunks) {
    // Allow one sentence of slack: a chunk is flushed after the sentence that
    // crosses the boundary, never mid-sentence.
    assert.ok(chunk.tokenEst <= 140, `chunk ${chunk.chunkIndex} was ${chunk.tokenEst} tokens`);
  }
});

test('chunks overlap so boundary facts stay retrievable', () => {
  const chunks = chunkPages([makePage(40, 'page one')], { targetTokens: 100, overlapTokens: 40 });

  const first = chunks[0];
  const second = chunks[1];
  const tailOfFirst = first.content.split(' ').slice(-5).join(' ');

  assert.ok(second.content.includes(tailOfFirst), 'second chunk should repeat the tail of the first');
});

test('no chunk ever spans more than one page', () => {
  // Citations are only checkable if a chunk maps to a single page. Short pages
  // are the tempting case to merge — assert we do not.
  const shortPages = ['Alpha fact on one.', 'Beta fact on two.', 'Gamma fact on three.'];
  const chunks = chunkPages(shortPages, { targetTokens: 400, overlapTokens: 60 });

  assert.equal(chunks.length, 3, 'each page should produce its own chunk');
  for (const chunk of chunks) {
    assert.equal(chunk.pageStart, chunk.pageEnd, `chunk ${chunk.chunkIndex} spans pages`);
  }
  assert.deepEqual(
    chunks.map((c) => c.pageStart),
    [1, 2, 3],
  );

  // Also holds when pages are long enough to split internally.
  const longPages = [makePage(40, 'page one'), makePage(40, 'page two')];
  for (const chunk of chunkPages(longPages, { targetTokens: 100, overlapTokens: 20 })) {
    assert.equal(chunk.pageStart, chunk.pageEnd);
  }
});

test('chunk indexes are contiguous from zero', () => {
  const chunks = chunkPages([makePage(30, 'p1'), makePage(30, 'p2')], {
    targetTokens: 80,
    overlapTokens: 15,
  });
  assert.deepEqual(
    chunks.map((c) => c.chunkIndex),
    chunks.map((_, i) => i),
  );
});

test('tracks the page each chunk came from', () => {
  const chunks = chunkPages([makePage(10, 'page one'), makePage(10, 'page two')], {
    targetTokens: 100,
    overlapTokens: 10,
  });

  for (const chunk of chunks) {
    assert.ok(chunk.pageStart >= 1 && chunk.pageEnd <= 2);
    assert.ok(chunk.pageStart <= chunk.pageEnd, 'page range must not be inverted');
  }

  const pagesSeen = new Set(chunks.flatMap((c) => [c.pageStart, c.pageEnd]));
  assert.ok(pagesSeen.has(1) && pagesSeen.has(2), 'both pages should be represented');
});

test('a sentence longer than the target becomes its own chunk instead of being dropped', () => {
  const giant = `${'word '.repeat(500)}.`;
  const chunks = chunkPages([giant], { targetTokens: 100, overlapTokens: 20 });

  assert.equal(chunks.length, 1);
  assert.ok(chunks[0].tokenEst > 100);
  assert.ok(chunks[0].content.includes('word'));
});

test('empty and whitespace-only pages produce no chunks', () => {
  assert.equal(chunkPages([]).length, 0);
  assert.equal(chunkPages(['', '   ']).length, 0);
});

test('token estimate scales with length', () => {
  assert.ok(estimateTokens('a'.repeat(400)) > estimateTokens('a'.repeat(100)));
});
