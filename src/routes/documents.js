import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import express from 'express';
import multer from 'multer';
import { query } from '../db.js';
import { config } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { enqueueIngest } from '../services/queue.js';
import { UPLOAD_DIR, storagePathFor } from '../services/ingest.js';

export const documentsRouter = express.Router();

documentsRouter.use(requireAuth);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype !== 'application/pdf') {
      return cb(new Error('Only PDF uploads are supported'));
    }
    cb(null, true);
  },
});

documentsRouter.post('/', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded (expected form field "file")' });
    }

    // Content hash, not filename: the same PDF uploaded twice under different
    // names should not be parsed and embedded twice.
    const contentHash = crypto.createHash('sha256').update(req.file.buffer).digest('hex');

    const existing = await query(
      'SELECT id, status, filename, chunk_count FROM documents WHERE user_id = $1 AND content_hash = $2',
      [req.user.id, contentHash],
    );

    if (existing.rows.length > 0) {
      const doc = existing.rows[0];
      // A previous attempt that failed is worth retrying; a ready one is not.
      if (doc.status === 'failed') {
        await enqueueIngest(doc.id);
      }
      return res.status(200).json({
        id: Number(doc.id),
        filename: doc.filename,
        status: doc.status === 'failed' ? 'pending' : doc.status,
        deduplicated: true,
      });
    }

    await fs.mkdir(UPLOAD_DIR, { recursive: true });
    await fs.writeFile(storagePathFor(contentHash), req.file.buffer);

    const { rows } = await query(
      `INSERT INTO documents (user_id, filename, content_hash, size_bytes)
       VALUES ($1, $2, $3, $4)
       RETURNING id, filename, status, created_at`,
      [req.user.id, req.file.originalname, contentHash, req.file.size],
    );

    const doc = rows[0];
    await enqueueIngest(doc.id);

    res.status(202).json({
      id: Number(doc.id),
      filename: doc.filename,
      status: doc.status,
      message: 'Upload accepted. Poll this document for status until it reads "ready".',
    });
  } catch (err) {
    next(err);
  }
});

documentsRouter.get('/', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, filename, status, page_count, chunk_count, size_bytes, error_message, created_at
         FROM documents
        WHERE user_id = $1
        ORDER BY created_at DESC`,
      [req.user.id],
    );
    res.json({ documents: rows.map((r) => ({ ...r, id: Number(r.id) })) });
  } catch (err) {
    next(err);
  }
});

documentsRouter.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, filename, status, page_count, chunk_count, size_bytes, error_message, created_at
         FROM documents
        WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Document not found' });
    res.json({ ...rows[0], id: Number(rows[0].id) });
  } catch (err) {
    next(err);
  }
});

documentsRouter.delete('/:id', async (req, res, next) => {
  try {
    // Chunks cascade with the document row.
    const { rowCount } = await query('DELETE FROM documents WHERE id = $1 AND user_id = $2', [
      req.params.id,
      req.user.id,
    ]);
    if (rowCount === 0) return res.status(404).json({ error: 'Document not found' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
