-- ================================================================
-- NyayAI RAG Pipeline — Supabase Schema
-- Run this in Supabase → SQL Editor → New Query
-- ================================================================

-- Enable pgvector extension
create extension if not exists vector;

-- 1. DOCUMENTS
create table if not exists documents (
  id             uuid primary key default gen_random_uuid(),
  title          text not null,
  description    text,
  cat_key        text not null,
  file_name      text not null,
  file_size      int,
  source_url     text,
  effective_date date,
  uploaded_by    text,
  is_active      boolean not null default true,
  created_at     timestamptz not null default now()
);

create index if not exists documents_cat_key_idx on documents(cat_key);
create index if not exists documents_active_idx  on documents(is_active);

-- 2. DOCUMENT CHUNKS with embeddings
create table if not exists document_chunks (
  id           uuid primary key default gen_random_uuid(),
  document_id  uuid not null references documents(id) on delete cascade,
  cat_key      text not null,
  chunk_index  int not null,
  content      text not null,
  embedding    vector(1536),
  token_count  int,
  created_at   timestamptz not null default now()
);

create index if not exists chunks_document_idx on document_chunks(document_id);
create index if not exists chunks_cat_key_idx  on document_chunks(cat_key);

-- Vector similarity index
create index if not exists chunks_embedding_idx
  on document_chunks
  using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

-- 3. SIMILARITY SEARCH FUNCTION
create or replace function search_chunks(
  query_embedding    vector(1536),
  filter_cat_key     text,
  match_count        int default 5,
  similarity_threshold float default 0.4
)
returns table (
  id             uuid,
  document_id    uuid,
  content        text,
  similarity     float,
  doc_title      text,
  doc_source     text,
  effective_date date
)
language sql stable
as $$
  select
    dc.id,
    dc.document_id,
    dc.content,
    1 - (dc.embedding <=> query_embedding) as similarity,
    d.title        as doc_title,
    d.source_url   as doc_source,
    d.effective_date
  from document_chunks dc
  join documents d on d.id = dc.document_id
  where
    dc.cat_key = filter_cat_key
    and d.is_active = true
    and 1 - (dc.embedding <=> query_embedding) > similarity_threshold
  order by dc.embedding <=> query_embedding
  limit match_count;
$$;

-- 4. RAG QUERY LOG
create table if not exists rag_query_log (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid,
  cat_key      text not null,
  user_query   text not null,
  chunks_found int not null default 0,
  created_at   timestamptz not null default now()
);
