/**
 * rag.js — RAG Pipeline for NyayAI
 *
 * Flow:
 * 1. Admin uploads PDF → extract text → chunk → embed → store in Supabase
 * 2. User sends query → embed query → search similar chunks → inject into Claude prompt
 * 3. Claude answers using retrieved context + its own knowledge
 *
 * Embeddings: Uses Anthropic's claude-haiku to create embeddings via a
 * clever trick — we use OpenAI's text-embedding-ada-002 (cheapest, most compatible)
 * OR fall back to a simple TF-IDF keyword match if no OpenAI key.
 */

const { supabase } = require('./db');
const pdfParse = require('pdf-parse');

// ── Constants ─────────────────────────────────────────────────
const CHUNK_SIZE     = 800;   // characters per chunk
const CHUNK_OVERLAP  = 150;   // overlap between chunks for context continuity
const MAX_CHUNKS_CTX = 4;     // max chunks to inject into Claude prompt
const EMBED_MODEL    = 'text-embedding-ada-002';
const EMBED_DIM      = 1536;

// ════════════════════════════════════════════════════════════════
// EMBEDDING — generate vector for a text string
// Uses OpenAI ada-002 (₹0.001 per 1000 tokens — extremely cheap)
// Falls back to keyword search if OPENAI_API_KEY not set
// ════════════════════════════════════════════════════════════════
async function getEmbedding(text) {
  const key = process.env.OPENAI_API_KEY;
  if (!key || key === 'sk-your-openai-key') {
    // Fallback: return null (will use keyword search instead)
    return null;
  }

  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${key}`,
    },
    body: JSON.stringify({ input: text.slice(0, 8000), model: EMBED_MODEL }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Embedding API error: ${err}`);
  }

  const data = await res.json();
  return data.data[0].embedding;  // array of 1536 floats
}

// ════════════════════════════════════════════════════════════════
// TEXT CHUNKING — split document text into overlapping chunks
// ════════════════════════════════════════════════════════════════
function chunkText(text) {
  const chunks = [];
  let start = 0;

  // Clean the text first
  const clean = text
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s{3,}/g, ' ')
    .trim();

  while (start < clean.length) {
    let end = start + CHUNK_SIZE;

    // Try to break at sentence boundary
    if (end < clean.length) {
      const boundary = clean.lastIndexOf('.', end);
      if (boundary > start + CHUNK_SIZE * 0.5) end = boundary + 1;
    }

    const chunk = clean.slice(start, end).trim();
    if (chunk.length > 50) {  // skip tiny chunks
      chunks.push(chunk);
    }

    start = end - CHUNK_OVERLAP;
  }

  return chunks;
}

// ════════════════════════════════════════════════════════════════
// PDF PROCESSING — extract text from PDF buffer
// ════════════════════════════════════════════════════════════════
async function extractTextFromPDF(buffer) {
  try {
    const data = await pdfParse(buffer);
    return data.text;
  } catch (err) {
    throw new Error(`PDF parsing failed: ${err.message}`);
  }
}

// ════════════════════════════════════════════════════════════════
// INGEST DOCUMENT — full pipeline: PDF → chunks → embeddings → Supabase
// ════════════════════════════════════════════════════════════════
async function ingestDocument({ buffer, title, description, catKey, fileName, fileSize, sourceUrl, effectiveDate, uploadedBy }) {
  console.log(`[RAG] Ingesting: ${title} (${catKey})`);

  // 1. Extract text
  const text   = await extractTextFromPDF(buffer);
  console.log(`[RAG] Extracted ${text.length} chars`);

  // 2. Create document record
  const { data: doc, error: docErr } = await supabase
    .from('documents')
    .insert({
      title,
      description:    description || null,
      cat_key:        catKey,
      file_name:      fileName,
      file_size:      fileSize || buffer.length,
      source_url:     sourceUrl || null,
      effective_date: effectiveDate || null,
      uploaded_by:    uploadedBy || 'admin',
      is_active:      true,
    })
    .select()
    .single();

  if (docErr) throw new Error(`Document insert failed: ${docErr.message}`);

  // 3. Chunk text
  const chunks = chunkText(text);
  console.log(`[RAG] Created ${chunks.length} chunks`);

  // 4. Embed each chunk and store
  let stored = 0;
  const batchSize = 10;  // process in batches to avoid rate limits

  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);

    const chunkRecords = await Promise.all(
      batch.map(async (content, j) => {
        const embedding = await getEmbedding(content);
        return {
          document_id: doc.id,
          cat_key:     catKey,
          chunk_index: i + j,
          content,
          embedding:   embedding ? JSON.stringify(embedding) : null,
          token_count: Math.ceil(content.length / 4),
        };
      })
    );

    const { error: chunkErr } = await supabase
      .from('document_chunks')
      .insert(chunkRecords);

    if (chunkErr) {
      console.error(`[RAG] Chunk batch ${i} error:`, chunkErr.message);
    } else {
      stored += batch.length;
    }

    // Small delay to avoid rate limits
    if (i + batchSize < chunks.length) {
      await new Promise(r => setTimeout(r, 200));
    }
  }

  console.log(`[RAG] Stored ${stored}/${chunks.length} chunks for doc ${doc.id}`);
  return { docId: doc.id, chunks: stored, title };
}

// ════════════════════════════════════════════════════════════════
// RETRIEVE — find relevant chunks for a user query
// ════════════════════════════════════════════════════════════════
async function retrieveContext(query, catKey, userId = null) {
  // 1. Embed the query
  const queryEmbedding = await getEmbedding(query);

  let chunks = [];

  if (queryEmbedding) {
    // Vector similarity search
    const { data, error } = await supabase.rpc('search_chunks', {
      query_embedding:      queryEmbedding,
      filter_cat_key:       catKey,
      match_count:          MAX_CHUNKS_CTX,
      similarity_threshold: 0.4,
    });

    if (!error && data) chunks = data;
  }

  // Fallback: keyword search if no embedding or no vector results
  if (chunks.length === 0) {
    chunks = await keywordSearch(query, catKey);
  }

  // Log the query
  supabase.from('rag_query_log').insert({
    user_id:      userId || null,
    cat_key:      catKey,
    user_query:   query.slice(0, 500),
    chunks_found: chunks.length,
  }).then(() => {}).catch(() => {});

  return chunks;
}

// ════════════════════════════════════════════════════════════════
// KEYWORD SEARCH — fallback when no OpenAI key / no vector results
// Searches chunk text directly using Supabase full-text search
// ════════════════════════════════════════════════════════════════
async function keywordSearch(query, catKey) {
  // Extract key terms (remove common words)
  const stopWords = new Set(['what','is','are','the','a','an','in','of','for','to','and','or','my','i','me','how','can','do','does','when','where','which']);
  const terms = query
    .toLowerCase()
    .replace(/[^a-zA-Z0-9\u0900-\u097F ]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w))
    .slice(0, 5);

  if (terms.length === 0) return [];

  // Search using ilike for each term
  const { data, error } = await supabase
    .from('document_chunks')
    .select(`
      id, document_id, content,
      documents!inner(title, source_url, effective_date, is_active, cat_key)
    `)
    .eq('cat_key', catKey)
    .eq('documents.is_active', true)
    .or(terms.map(t => `content.ilike.%${t}%`).join(','))
    .limit(MAX_CHUNKS_CTX);

  if (error || !data) return [];

  return data.map(c => ({
    id:             c.id,
    document_id:    c.document_id,
    content:        c.content,
    similarity:     0.5,
    doc_title:      c.documents?.title,
    doc_source:     c.documents?.source_url,
    effective_date: c.documents?.effective_date,
  }));
}

// ════════════════════════════════════════════════════════════════
// BUILD CONTEXT STRING — format retrieved chunks for Claude prompt
// ════════════════════════════════════════════════════════════════
function buildContextString(chunks) {
  if (!chunks || chunks.length === 0) return null;

  const lines = [
    '═══════════════════════════════════════════',
    'VERIFIED LEGAL DOCUMENTS FROM DATABASE:',
    '(Use this information to validate and enhance your answer)',
    '═══════════════════════════════════════════',
  ];

  chunks.forEach((chunk, i) => {
    const dateStr = chunk.effective_date
      ? ` (Effective: ${new Date(chunk.effective_date).toLocaleDateString('en-IN')})`
      : '';
    lines.push(`\n[Document ${i + 1}: ${chunk.doc_title}${dateStr}]`);
    if (chunk.doc_source) lines.push(`[Source: ${chunk.doc_source}]`);
    lines.push(chunk.content);
  });

  lines.push('\n═══════════════════════════════════════════');
  lines.push('If the above documents contain relevant information, prioritise them over general knowledge.');
  lines.push('If documents are outdated or incomplete, combine with your training knowledge.');
  lines.push('Always mention which document you are referencing.');
  lines.push('═══════════════════════════════════════════');

  return lines.join('\n');
}

// ════════════════════════════════════════════════════════════════
// DOCUMENT MANAGEMENT
// ════════════════════════════════════════════════════════════════
async function listDocuments(catKey = null) {
  let query = supabase
    .from('documents')
    .select('id, title, description, cat_key, file_name, file_size, source_url, effective_date, is_active, created_at')
    .order('created_at', { ascending: false });

  if (catKey) query = query.eq('cat_key', catKey);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return data || [];
}

async function deleteDocument(docId) {
  // Chunks are cascade deleted via FK
  const { error } = await supabase
    .from('documents')
    .delete()
    .eq('id', docId);
  if (error) throw new Error(error.message);
  return true;
}

async function toggleDocument(docId, isActive) {
  const { data, error } = await supabase
    .from('documents')
    .update({ is_active: isActive })
    .eq('id', docId)
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

async function getDocumentStats() {
  const { data: docs }   = await supabase.from('documents').select('cat_key, is_active');
  const { data: chunks } = await supabase.from('document_chunks').select('cat_key');
  const { data: logs }   = await supabase.from('rag_query_log').select('cat_key, chunks_found');

  const stats = {};
  (docs || []).forEach(d => {
    if (!stats[d.cat_key]) stats[d.cat_key] = { docs: 0, active: 0, chunks: 0, queries: 0, hits: 0 };
    stats[d.cat_key].docs++;
    if (d.is_active) stats[d.cat_key].active++;
  });
  (chunks || []).forEach(c => {
    if (!stats[c.cat_key]) stats[c.cat_key] = { docs: 0, active: 0, chunks: 0, queries: 0, hits: 0 };
    stats[c.cat_key].chunks++;
  });
  (logs || []).forEach(l => {
    if (!stats[l.cat_key]) stats[l.cat_key] = { docs: 0, active: 0, chunks: 0, queries: 0, hits: 0 };
    stats[l.cat_key].queries++;
    if (l.chunks_found > 0) stats[l.cat_key].hits++;
  });

  return stats;
}

module.exports = {
  ingestDocument,
  retrieveContext,
  buildContextString,
  extractTextFromPDF,
  listDocuments,
  deleteDocument,
  toggleDocument,
  getDocumentStats,
};