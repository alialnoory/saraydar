-- Original Abuquwa tracker schema (kept as-is).
create table if not exists users (
  id            uuid primary key default gen_random_uuid(),
  email         text not null,
  name          text not null default '',
  role          text not null default 'viewer' check (role in ('admin', 'editor', 'site', 'viewer')),
  password_hash text not null,
  active        boolean not null default true,
  token_version integer not null default 0,
  created_at    timestamptz not null default now()
);
create unique index if not exists users_email_key on users (lower(email));

create table if not exists records (
  collection text not null check (collection in ('tasks', 'costs', 'payments', 'units', 'risks', 'log', 'meta')),
  id         text not null,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid references users(id) on delete set null,
  primary key (collection, id)
);

create table if not exists record_history (
  history_id       bigint generated always as identity primary key,
  collection       text not null,
  id               text not null,
  action           text not null,
  old_data         jsonb,
  new_data         jsonb,
  changed_by       uuid references users(id) on delete set null,
  changed_by_email text,
  changed_at       timestamptz not null default now()
);
create index if not exists record_history_changed_at on record_history (changed_at desc);

create table if not exists app_state (
  key   text primary key,
  value text not null
);
