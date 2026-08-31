-- Run this once in Supabase (Project -> SQL Editor -> New query -> paste -> Run).
-- Creates the tables backing the team-shared History feature. Safe to
-- re-run - every statement is idempotent (IF NOT EXISTS).

create extension if not exists "pgcrypto";

create table if not exists batches (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  created_by text not null,
  name text,
  hashtag_count int not null default 0,
  flags jsonb not null default '[]'::jsonb
);

create index if not exists idx_batches_created_at on batches (created_at desc);

create table if not exists batch_rows (
  id bigserial primary key,
  batch_id uuid not null references batches (id) on delete cascade,
  row_index int not null,
  cat1 text not null default '',
  cat2 text not null default '',
  cat3 text not null default '',
  cat4 text not null default '',
  cat5 text not null default '',
  brand text not null default '',
  product_line text not null default '',
  hashtag text not null default '',
  inclusion text not null default '',
  new_label text not null default '',
  comments text not null default '',
  edited boolean not null default false
);

create index if not exists idx_batch_rows_batch_id on batch_rows (batch_id);
