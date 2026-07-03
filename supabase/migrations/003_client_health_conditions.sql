-- Run this in your Supabase SQL Editor if you already deployed before this update.
-- Safe to run more than once.

alter table clients add column if not exists health_conditions jsonb not null default '[]'::jsonb;
