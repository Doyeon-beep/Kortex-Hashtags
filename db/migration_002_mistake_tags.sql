-- Run this once in Supabase (Project -> SQL Editor -> New query -> paste -> Run).
-- Adds mistake-type tagging and an immutable snapshot of the AI's original
-- classification (for the Data Quality tab's "what changed" view). Safe to
-- re-run.

alter table batch_rows add column if not exists mistake_tag text;

-- Lives on batches (one array, in row order), not batch_rows - the rename/
-- edit endpoint deletes and reinserts every batch_rows row on every save, so
-- a per-row snapshot column there would get wiped the moment anyone edited
-- anything. This is written once at creation and never touched again.
alter table batches add column if not exists original_rows jsonb;

create index if not exists idx_batch_rows_mistake_tag on batch_rows (mistake_tag) where mistake_tag is not null;
