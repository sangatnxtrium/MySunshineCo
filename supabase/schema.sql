-- MySunshineCo — Supabase Postgres schema
-- Run this once in the Supabase SQL Editor (Project > SQL Editor > New query) before deploying.
-- Uses text primary keys (matching the app's existing "prefix_hex" id style) and
-- jsonb columns for nested data (certifications, call-in/out, checklist items) so the
-- server code stays close to the original in-memory JSON model.

-- pgcrypto gives us crypt()/gen_salt('bf') to generate real bcrypt hashes right here in
-- SQL — the same hash format Node's bcryptjs produces, so the app can verify them normally.
create extension if not exists pgcrypto;

create table if not exists users (
  id text primary key,
  name text not null,
  username text not null unique,
  password_hash text not null,
  role text not null check (role in ('admin','caregiver')),
  phone text default '',
  email text default '',
  hire_date date,
  hourly_wage numeric(10,2) default 0,
  certifications jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists clients (
  id text primary key,
  name text not null,
  address text default '',
  phone text default '',
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists shifts (
  id text primary key,
  caregiver_id text not null references users(id) on delete cascade,
  client_id text not null references clients(id) on delete restrict,
  date date not null,
  start_time timestamptz not null,
  end_time timestamptz not null,
  status text not null default 'scheduled' check (status in ('scheduled','in-progress','completed','skipped')),
  call_in jsonb,
  call_out jsonb,
  activities jsonb not null default '[]'::jsonb,
  notes text default '',
  skip_reason text,
  resolved boolean default false,
  created_at timestamptz not null default now()
);
create index if not exists idx_shifts_caregiver on shifts(caregiver_id);
create index if not exists idx_shifts_date on shifts(date);

create table if not exists documents (
  id text primary key,
  name text not null,
  category text default 'Other',
  related_to text not null, -- 'agency' or a users.id
  uploaded_by text not null,
  uploaded_by_id text references users(id) on delete set null,
  uploaded_on date not null default current_date,
  expires_on date,
  storage_path text, -- path inside the Supabase Storage bucket; null = no real file attached
  original_name text,
  mime_type text,
  created_at timestamptz not null default now()
);
create index if not exists idx_documents_related_to on documents(related_to);

create table if not exists messages (
  id text primary key,
  from_id text not null references users(id) on delete cascade,
  from_name text not null,
  to_id text not null, -- 'all' or a users.id
  subject text not null,
  body text not null,
  date timestamptz not null default now(),
  read_by jsonb not null default '[]'::jsonb
);
create index if not exists idx_messages_to on messages(to_id);

create table if not exists task_templates (
  id text primary key,
  name text not null unique
);

-- Seed the one Office Admin account so you have a way to log in on first deploy.
-- Password is "admin123" — CHANGE IT immediately after your first login (My Account,
-- or reset it here later with: update users set password_hash = crypt('newpassword', gen_salt('bf')) where username = 'admin';).
insert into users (id, name, username, password_hash, role, phone, email, hire_date, hourly_wage, certifications) values
  ('admin1', 'Office Admin', 'admin', crypt('admin123', gen_salt('bf')), 'admin', '(555) 100-0000', 'office@mysunshineco.example', '2020-01-01', 0, '[]')
on conflict (id) do nothing;

insert into task_templates (id, name) values
  ('tpl_bathing', 'Bathing / grooming assistance'),
  ('tpl_dressing', 'Dressing assistance'),
  ('tpl_mobility', 'Mobility / transfer assistance'),
  ('tpl_medication', 'Medication reminder'),
  ('tpl_meal', 'Meal preparation'),
  ('tpl_housekeeping', 'Light housekeeping'),
  ('tpl_vitals', 'Vital signs check'),
  ('tpl_safety', 'Safety / wellness check'),
  ('tpl_notes', 'Visit notes completed')
on conflict (id) do nothing;

-- No demo caregiver accounts are seeded here on purpose — this is meant to go live
-- with real staff. Log in as admin and create real caregiver accounts from
-- "Caregiver Roster & Accounts", and add your real clients from "Clients".
