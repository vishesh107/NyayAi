/**
 * routes/documents.js — Document upload & RAG admin API
 *
 * Admin routes:
 *   POST   /api/documents/upload        — upload PDF, ingest into RAG
 *   GET    /api/documents               — list all documents
 *   GET    /api/documents/stats         — RAG stats per bot
 *   DELETE /api/documents/:id           — delete document + chunks
 *   PATCH  /api/documents/:id/toggle    — enable/disable document
 *
 * All routes require admin email in ADMIN_EMAILS env var
 */

const express = require('express');
const multer  = require('multer');
const { authMiddleware } = require('../middleware/auth');
const { BOTS }           = require('../config/bots');
const {
  ingestDocument,
  listDocuments,
  deleteDocument,
  toggleDocument,
  getDocumentStats,
} = require('../rag');

const router = express.Router();

// ── Multer — store PDF in memory (max 20MB) ───────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed'));
    }
  },
});

// ── Admin check middleware ────────────────────────────────────
function adminOnly(req, res, next) {
  const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim());
  if (!adminEmails.includes(req.user.email)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// ══════════════════════════════════════════════════════════════
// POST /api/documents/upload — upload and ingest a PDF
// ══════════════════════════════════════════════════════════════
router.post('/upload', authMiddleware, adminOnly, upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No PDF file uploaded' });
    }

    const { catKey, title, description, sourceUrl, effectiveDate } = req.body;

    // Validate
    if (!catKey || !BOTS[catKey]) {
      return res.status(400).json({
        error:       'Invalid catKey',
        validValues: Object.keys(BOTS),
      });
    }
    if (!title || title.trim().length < 3) {
      return res.status(400).json({ error: 'Title is required (min 3 chars)' });
    }

    console.log(`[Docs] Upload started: ${title} | bot: ${catKey} | size: ${req.file.size}`);

    const result = await ingestDocument({
      buffer:        req.file.buffer,
      title:         title.trim(),
      description:   description?.trim() || null,
      catKey,
      fileName:      req.file.originalname,
      fileSize:      req.file.size,
      sourceUrl:     sourceUrl?.trim() || null,
      effectiveDate: effectiveDate || null,
      uploadedBy:    req.user.email,
    });

    res.status(201).json({
      message:  `Document "${title}" ingested successfully`,
      docId:    result.docId,
      chunks:   result.chunks,
      catKey,
    });
  } catch (err) {
    console.error('[Docs] Upload error:', err.message);
    res.status(500).json({ error: err.message || 'Document ingestion failed' });
  }
});

// ══════════════════════════════════════════════════════════════
// GET /api/documents — list all documents
// ══════════════════════════════════════════════════════════════
router.get('/', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { catKey } = req.query;
    const docs = await listDocuments(catKey || null);
    res.json({ documents: docs, total: docs.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// GET /api/documents/stats — RAG stats per bot
// ══════════════════════════════════════════════════════════════
router.get('/stats', authMiddleware, adminOnly, async (req, res) => {
  try {
    const stats = await getDocumentStats();
    res.json({ stats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// DELETE /api/documents/:id — delete document and all its chunks
// ══════════════════════════════════════════════════════════════
router.delete('/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    await deleteDocument(req.params.id);
    res.json({ message: 'Document deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// PATCH /api/documents/:id/toggle — enable or disable a document
// ══════════════════════════════════════════════════════════════
router.patch('/:id/toggle', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { isActive } = req.body;
    if (typeof isActive !== 'boolean') {
      return res.status(400).json({ error: 'isActive must be true or false' });
    }
    const doc = await toggleDocument(req.params.id, isActive);
    res.json({ message: `Document ${isActive ? 'enabled' : 'disabled'}`, document: doc });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;