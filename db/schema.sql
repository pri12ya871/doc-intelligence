-- Doc Intelligence schema.
-- Requires the pgvector extension (bundled in the pgvector/pgvector Docker image).

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS users (
    id            BIGSERIAL PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS documents (
    id            BIGSERIAL PRIMARY KEY,
    user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    filename      TEXT NOT NULL,
    -- SHA-256 of the raw bytes. Re-uploading the same file for the same user
    -- reuses the existing row instead of paying to embed it twice.
    content_hash  TEXT NOT NULL,
    size_bytes    BIGINT NOT NULL,
    page_count    INT,
    status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'processing', 'ready', 'failed')),
    error_message TEXT,
    chunk_count   INT NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, content_hash)
);

CREATE INDEX IF NOT EXISTS documents_user_created_idx
    ON documents (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS chunks (
    id          BIGSERIAL PRIMARY KEY,
    document_id BIGINT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    chunk_index INT NOT NULL,
    page_start  INT NOT NULL,
    page_end    INT NOT NULL,
    content     TEXT NOT NULL,
    token_est   INT NOT NULL,
    embedding   vector(1024),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (document_id, chunk_index)
);

-- Tenant isolation lives in the WHERE clause of every retrieval query, so the
-- user_id index matters as much as the vector index.
CREATE INDEX IF NOT EXISTS chunks_user_idx ON chunks (user_id);
CREATE INDEX IF NOT EXISTS chunks_document_idx ON chunks (document_id);

-- IVFFlat over cosine distance. Build it after some data exists for best
-- results; `lists` should be roughly sqrt(row_count).
CREATE INDEX IF NOT EXISTS chunks_embedding_idx
    ON chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

CREATE TABLE IF NOT EXISTS query_log (
    id           BIGSERIAL PRIMARY KEY,
    user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    document_id  BIGINT REFERENCES documents(id) ON DELETE SET NULL,
    question     TEXT NOT NULL,
    cache_hit    BOOLEAN NOT NULL DEFAULT false,
    input_tokens INT,
    output_tokens INT,
    latency_ms   INT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS query_log_user_created_idx
    ON query_log (user_id, created_at DESC);
