// Regenerates samples/doc-intelligence-design-notes.pdf, the document every
// demo account starts with. Hand-written PDF output keeps this dependency-free:
// the file only needs text that pdf.js can extract page by page.
//
//   node scripts/make-sample-pdf.js

import fs from 'node:fs';
import path from 'node:path';

const pages = [
  {
    title: 'Doc Intelligence: Design Notes',
    body: [
      'Doc Intelligence answers questions about PDFs with citations that point to the exact page. It is a retrieval-augmented generation (RAG) system: the model never answers from memory, only from excerpts retrieved out of the documents a user has uploaded.',
      'Ingestion. An upload is stored and acknowledged immediately; the heavy work runs in the background. Text is extracted page by page, split into chunks of roughly 400 tokens that overlap by about 60, embedded with Voyage (voyage-3, 1024 dimensions) and written to Postgres in a single transaction. A document is never marked ready while only part of it is embedded, because answering from partial evidence is worse than failing.',
      'Deduplication. Every upload is hashed with SHA-256. Uploading the same bytes twice, even under a different filename, reuses the existing document instead of paying to embed it again.',
      'Scanned PDFs contain images rather than text. They fail ingestion with a clear message saying OCR is needed, rather than silently producing an empty index.',
    ],
  },
  {
    title: 'Retrieval and Answers',
    body: [
      'Vectors live in Postgres through the pgvector extension, indexed with IVFFlat over cosine distance. Keeping vectors next to the relational data means one database, one backup and one transaction boundary instead of a separate vector store to keep in sync.',
      'A question is embedded with the query input type, and the eight most similar chunks are retrieved. Voyage encodes documents and queries with different prefixes; using the document type for both measurably lowers recall.',
      'The answer streams back over server-sent events, token by token. The model is instructed to cite excerpts as [1], [2] and so on, and each marker resolves to a filename and a page range the reader can verify.',
      'Identical questions over the same documents are cached for six hours. The cache key includes the user id, because the same question asked by two users has two different correct answers.',
    ],
  },
  {
    title: 'Security and Limits',
    body: [
      'Tenant isolation. Every document and chunk query filters on the authenticated user id. That WHERE clause is the tenant boundary, which is why the chunks table carries its own user_id column and index rather than joining through documents.',
      'Authentication uses bcrypt-hashed passwords and signed JWTs. A login for an unknown email still performs a bcrypt comparison, so a wrong email and a wrong password take the same time to answer.',
      'Rate limits. Asking questions is limited to 60 per user per hour, because every answer spends real model quota. Sign-in attempts are limited per IP address to slow down credential stuffing. When Redis is unavailable the limiter fails open rather than taking the API down.',
      'Demo accounts are created with one click, start with a copy of this document, and are deleted automatically after two days.',
    ],
  },
];

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 72;
const BODY_SIZE = 11;
const LEADING = 16;
// Helvetica averages about half an em per character; wrapping by count is
// accurate enough for plain prose.
const MAX_CHARS = Math.floor((PAGE_W - 2 * MARGIN) / (BODY_SIZE * 0.5));

function wrap(text) {
  const lines = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line && line.length + 1 + word.length > MAX_CHARS) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

const escapePdf = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

function contentStream(page, pageNumber) {
  const ops = ['BT', `/F2 18 Tf`, `${MARGIN} ${PAGE_H - MARGIN} Td`, `(${escapePdf(page.title)}) Tj`, 'ET'];
  let y = PAGE_H - MARGIN - 36;
  for (const paragraph of page.body) {
    for (const line of wrap(paragraph)) {
      ops.push('BT', `/F1 ${BODY_SIZE} Tf`, `${MARGIN} ${y} Td`, `(${escapePdf(line)}) Tj`, 'ET');
      y -= LEADING;
    }
    y -= LEADING / 2;
  }
  ops.push('BT', '/F1 9 Tf', `${PAGE_W / 2 - 12} 40 Td`, `(Page ${pageNumber}) Tj`, 'ET');
  return ops.join('\n');
}

// Object layout: 1 catalog, 2 page tree, 3-4 fonts, then a page + content pair per page.
const objects = [];
const pageIds = pages.map((_, i) => 5 + i * 2);

objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
objects[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';

pages.forEach((page, i) => {
  const pageId = pageIds[i];
  const stream = contentStream(page, i + 1);
  objects[pageId] =
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
    `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${pageId + 1} 0 R >>`;
  objects[pageId + 1] = `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`;
});

let pdf = '%PDF-1.4\n';
const offsets = [];
for (let id = 1; id < objects.length; id += 1) {
  offsets[id] = Buffer.byteLength(pdf, 'latin1');
  pdf += `${id} 0 obj\n${objects[id]}\nendobj\n`;
}

const xrefAt = Buffer.byteLength(pdf, 'latin1');
pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
for (let id = 1; id < objects.length; id += 1) {
  pdf += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
}
pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;

const out = path.resolve('samples/doc-intelligence-design-notes.pdf');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, pdf, 'latin1');
console.log(`wrote ${out} (${pages.length} pages)`);
