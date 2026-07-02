-- Run this ONLY if you already ran the original supabase/schema.sql against your
-- project before this update. If you haven't deployed yet, just use the updated
-- schema.sql instead — it already includes these columns.
--
-- Safe to run more than once (IF NOT EXISTS / IF EXISTS guards throughout).

alter table users add column if not exists sandata_id text default '';

alter table clients add column if not exists assigned_caregiver_ids jsonb not null default '[]'::jsonb;
