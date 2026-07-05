-- Run this in your Supabase SQL Editor if you already deployed before this update.
-- Safe to run more than once.

create table if not exists integration_settings (
  id text primary key,
  api_url text default '',
  api_key text default '',
  updated_at timestamptz,
  updated_by text
);
