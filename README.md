# Doc Intelligence

Upload PDFs, ask questions in plain English, get answers **grounded in citations that point back to the exact page**. A retrieval-augmented generation (RAG) system built as a production-shaped backend rather than a demo script.

Built by Priya Sharma.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/pri12ya871/doc-intelligence)

> **Demo notes:** the demo runs on Render's free tier in local mode — the
> instance sleeps when idle (first load can take ~50 seconds) and demo data
> resets on restarts. Create a throwaway account, upload a text-based PDF, and
> ask it questions. Answers are rate-limited per account because each one
> spends real LLM quota.

---

## What it does

1. You upload a PDF. The API stores it, returns immediately, and queues the work.
2. A background worker extracts text **page by page**, splits it into overlapping chunks, embeds each chunk, and stores the vectors in Postgres.
3. You ask a question. The system embeds the question, finds the most semantically similar chunks *belonging to you*, and asks Claude to answer using only those excerpts.
4. The answer streams back token by token with `[1]`, `[2]` markers, and every marker resolves to a filename and page range you can go verify.

---

## Architecture

```
                    ┌──────────────┐
   PDF upload ─────▶│  Express API │────▶ Postgres (users, documents, chunks + pgvector)
                    └──────┬───────┘
                           │ enqueue                    ▲
                           ▼                            │ vector search
                    ┌──────────────┐                    │
                    │ Redis (queue │                    │
                    │  + cache)    │                    │
                    └──────┬───────┘                    │
                           │ dequeue                    │
                           ▼                            │
                    ┌──────────────┐   embeddings   ┌───┴──────┐
                    │ BullMQ worker├───────────────▶│  Voyage  │
                    │ parse→chunk  │                └──────────┘
                    │ →embed→store │
                    └──────────────┘

   Question ──▶ embed ──▶ top-K chunks ──▶ Claude (streamed, SSE) ──▶ cited answer
```

**Stack:** Node.js · Express · PostgreSQL + pgvector · Redis · BullMQ · Claude (answers) · Voyage (embeddings) · Docker

---

## Running it

### Quickest — no installs, no accounts

Leave `DATABASE_URL` and `REDIS_URL` empty in `.env` and the app runs entirely
on this machine:

```bash
npm install
npm run migrate
npm start
```

Open http://localhost:3000, create an account, and sign in.

In this mode Postgres is [PGlite](https://pglite.dev) — the real PostgreSQL
engine compiled to WebAssembly, running in-process with real pgvector, storing
data in `./data/pgdata`. The SQL in this project is identical either way, so
nothing about the retrieval code changes. Redis is replaced by an in-memory
cache, and ingestion runs inside the API process instead of through a queue.

That last part is the honest tradeoff: **local mode gives up the things the
queue exists for** — retries, backoff, surviving a crash, and scaling the worker
separately from the API. It is for seeing the app work on one machine, not for
deploying. `npm run doctor` prints which mode you are in.

### With a real Postgres and Redis

You need an Anthropic API key and a Voyage API key either way.

```bash
cp .env.example .env
```

Fill in `ANTHROPIC_API_KEY`, `VOYAGE_API_KEY`, and a `JWT_SECRET`:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Then:

```bash
docker compose up --build
```

Open http://localhost:3000, create an account, upload a PDF, and ask it something.

### Running without Docker (hosted Postgres + Redis)

Nothing to install locally beyond Node. Both services have free tiers.

**1. Postgres — [Neon](https://neon.tech).** Create a project, then copy the
connection string from *Connection Details*. Take the **pooled** one (the host
contains `-pooler`) and keep the `?sslmode=require` on the end. pgvector is
available — `npm run migrate` runs `CREATE EXTENSION vector` for you.

**2. Redis — [Upstash](https://upstash.com).** Create a database, then copy the
**`rediss://` TCP URL**, not the REST/HTTPS one. BullMQ speaks the Redis wire
protocol, so the REST endpoint will not work.

**3. Put both in `.env`:**

```
DATABASE_URL=postgres://USER:PASSWORD@ep-xxx-pooler.REGION.aws.neon.tech/neondb?sslmode=require
REDIS_URL=rediss://default:PASSWORD@REGION.upstash.io:6379
```

**4. Verify the connection strings before anything else:**

```bash
npm install
npm run doctor
```

`doctor` checks that Postgres is reachable, that pgvector is available, that the
schema has been applied, and that Redis both answers and permits the scripting
BullMQ needs — printing a specific fix for whatever fails. It never prints a
connection string, only the host.

**5. Run it:**

```bash
npm run migrate     # creates tables + the vector extension
npm start           # API on :3000
npm run worker      # ingestion worker, in a second terminal
```

Two behaviours differ from a local database and are worth knowing:

- **Neon suspends after ~5 minutes idle.** The first query afterwards takes a
  few seconds while it wakes. That is why the connect and health-probe timeouts
  default to 10s and 8s rather than something tight — a waking database is
  healthy, and reporting it as down would be wrong.
- **Upstash bills per command.** A running worker polls the queue, so leave it
  stopped when you aren't ingesting if you're watching the free-tier quota.

The plain `postgres` Docker image does **not** include pgvector, which is why
compose uses `pgvector/pgvector:pg16`. A stock local Postgres install will also
fail at `CREATE EXTENSION vector` unless the extension is installed separately.

### When something doesn't work

The API distinguishes the two common local failures instead of returning a
generic error, so the message tells you which one you have:

| What you see | Cause |
| --- | --- |
| "Cannot reach the server" | The API process isn't running — `npm start` |
| "Database unavailable" (HTTP 503) | The API is up but Postgres isn't reachable — check `DATABASE_URL` |
| Uploads stay at `pending` forever | The worker isn't running (`npm run worker`) or Redis is unreachable |

Run `npm run doctor` first — it names the specific dependency that is failing
and what to do about it.

`GET /health` reports Postgres and Redis reachability independently, with a
2-second deadline on each probe so it can never hang.

### Tests

```bash
npm test
```

---

## API

All routes except `/health` and `/api/auth/*` need `Authorization: Bearer <token>`.

| Method | Route | Purpose |
| --- | --- | --- |
| `POST` | `/api/auth/register` | Create an account, returns a JWT |
| `POST` | `/api/auth/login` | Sign in, returns a JWT |
| `POST` | `/api/documents` | Upload a PDF (multipart, field `file`). Returns `202` and queues indexing |
| `GET` | `/api/documents` | List your documents and their indexing status |
| `GET` | `/api/documents/:id` | One document's status, page count, chunk count |
| `DELETE` | `/api/documents/:id` | Delete a document and its chunks |
| `POST` | `/api/chat/ask` | Ask a question. Streams SSE: `sources`, then `token`s, then `done` |
| `GET` | `/api/chat/history` | Your last 50 questions with token usage and latency |
| `GET` | `/health` | Liveness plus Postgres and Redis reachability |

Example:

```bash
TOKEN=$(curl -s -X POST localhost:3000/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"me@example.com","password":"supersecret"}' | jq -r .token)

curl -X POST localhost:3000/api/documents \
  -H "Authorization: Bearer $TOKEN" -F file=@contract.pdf

curl -N -X POST localhost:3000/api/chat/ask \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"question":"What is the termination notice period?"}'
```

---

## Design decisions

These are the parts worth asking me about.

**Ingestion is queued, not inline.** A 500-page PDF takes minutes to parse and embed. Doing that inside the upload request means a request that lives for minutes, a browser that times out, and no retry when the embedding API rate-limits you. The upload endpoint writes a row and returns `202`; a BullMQ worker does the real work with exponential backoff across three attempts. The client polls document status.

**Chunks overlap by design.** A fact that lands on a chunk boundary is otherwise retrievable by neither neighbouring chunk, because each one holds only half of it. Roughly 60 tokens of the previous chunk are carried into the next. Chunks are also split on sentence boundaries rather than a fixed character count, so a chunk never begins mid-word.

**Chunks never span pages.** This one came out of testing: with page-spanning chunks, a three-page document produced a single chunk covering pages 1–3, so every citation read "pages 1-3" — no more useful to a reader than citing the whole file. Confining each chunk to one page means every citation names exactly one page you can open and check. The cost is that a sentence straddling a page break gets split, which matters far less than losing the precision that citations exist for. There is a test asserting this invariant, because it is easy to regress by "helpfully" merging short pages.

**PDF text extraction uses `unpdf`, not `pdf-parse`.** `pdf-parse` bundles a 2018 build of pdf.js which throws `bad XRef entry` on entirely valid PDFs once PGlite's WebAssembly runtime has initialised in the same process. The two cannot coexist, and local mode needs both. `unpdf` wraps a current pdf.js, is native ESM, and exposes per-page extraction directly.

**The embedding client retries on 429.** Voyage's free tier permits 3 requests per minute, and any real document needs more than one batch. Without backoff, ingestion fails partway through and marks the document failed for a reason that would have cleared by waiting. It honours `Retry-After` when present and otherwise backs off from 20 seconds, retrying only 429 and 5xx — a 401 is returned immediately, since repeating it cannot help.

**Page numbers are tracked through the whole pipeline.** Text is extracted per page and never flattened into one blob, so every chunk knows the page range it came from. That is the entire basis of the citation feature — without it, "cited" answers would just be plausible-looking numbers.

**Citations are grounded structurally, not by asking nicely.** The model is only ever shown numbered excerpts and is told to cite by number. The numbers are assigned by my code, and the API returns the same numbered list to the client alongside the answer, so a citation can be checked against the excerpt it claims to come from. The model cannot invent a source that does not exist in the list it was given.

**Tenant isolation lives in SQL.** Every retrieval query carries `WHERE c.user_id = $2`. It is not a filter applied in application code after the fact, so there is no code path where one user's vector search reaches another user's documents.

**The storage layer is swappable, and the fallback is real Postgres.** With no
`DATABASE_URL` the app runs on PGlite — PostgreSQL compiled to WebAssembly,
in-process, with pgvector. It is not a mock or a SQLite substitute, so the
schema, the `<=>` cosine operator, and the transactional ingest path are
exercised identically to production. That keeps "works on my machine" and
"works on Neon" the same code path, and means a reviewer can clone the repo and
run it without provisioning anything.

**Deduplication is by content hash, not filename.** The same PDF re-uploaded under a different name reuses the existing index instead of paying to embed it a second time. Failed documents are re-queued on re-upload; ready ones are not.

**Answers are cached in Redis.** The cache key covers the user, the document scope, and the normalized question, because the same question over different users' documents has different correct answers. LLM calls are the expensive part of this system, and repeated questions are common.

**Rate limits protect the bill, not just the server.** The `/ask` limit is per-user per-hour because each call costs real money. The login limit is per-IP because that one is about credential stuffing. Both fail *open* if Redis is unreachable — a cache outage should not take the API down.

**Claude refusals are handled as a normal outcome.** Safety classifiers return a successful HTTP response with `stop_reason: "refusal"`, not an error, so code that reads `content[0]` unconditionally breaks on it. The request also opts into server-side fallbacks so a declined request is retried on a fallback model rather than dead-ending.

**Embeddings come from Voyage, answers from Claude or Gemini.** Anthropic does not serve an embeddings endpoint; Voyage is the provider they recommend. Queries and documents are embedded with different `input_type` values — using `document` for both measurably hurts recall, since Voyage encodes them with different prefixes into the same space.

**The answer model is swappable per provider key.** Retrieval never touches the LLM — embeddings and vector search are identical regardless of who writes the final answer — so the generation step is behind a small provider switch: set `ANTHROPIC_API_KEY` for Claude or `GEMINI_API_KEY` for Gemini (which has a free tier), and the app uses whichever is present. Both stream, both surface refusals as a distinct event rather than a failure, and both report token usage into the query log. The system prompt and the numbered-excerpt contract are shared, so citation grounding does not depend on the provider.

---

## Known limitations

Being upfront about these is more useful than pretending they don't exist:

- **Scanned PDFs are rejected.** If a PDF has no text layer, ingestion fails with an explicit message rather than silently indexing nothing. OCR is the natural next feature.
- **Retrieval is pure vector search.** Hybrid search (BM25 + vector, fused) would do better on exact-term queries like part numbers and proper nouns.
- **The IVFFlat index is built at schema time** with `lists = 100`. That is tuned for roughly ten thousand chunks; it should be rebuilt as the corpus grows.
- **Uploaded PDFs are never deleted from disk**, only their rows and chunks. Files are shared across users by content hash, so reference counting has to come first.
- **No answer-quality evaluation harness yet.** A golden set of question/answer/expected-page triples run in CI is the obvious next step. Manual testing against a three-page contract currently gets 5/5 on top-1 page accuracy, which is a starting point, not a benchmark.
- **Voyage's free tier is 3 requests/minute** until a payment method is added. Ingestion retries around it, but a large document will be slow until the limit is raised.

---

## Next steps

- OCR fallback for scanned documents
- Hybrid retrieval and a reranking pass over the top-K
- A retrieval-quality eval suite wired into CI
- Multi-turn conversations with follow-up questions over the same context
