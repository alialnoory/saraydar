-- Phase 2 foundation: identities, sessions, MFA, workspaces, memberships, parties, files, audit, outbox, numbering.

-- ---------- users (extends the original table; legacy "role" stays for the Abuquwa tracker API) ----------
alter table users add column if not exists username text;
alter table users add column if not exists system_role text not null default 'viewer';
alter table users add column if not exists kind text not null default 'internal';
alter table users add column if not exists mfa_secret text;
alter table users add column if not exists mfa_enabled boolean not null default false;
alter table users add column if not exists mfa_recovery jsonb not null default '[]'::jsonb;
alter table users add column if not exists failed_logins integer not null default 0;
alter table users add column if not exists locked_until timestamptz;
alter table users add column if not exists last_login_at timestamptz;
alter table users add column if not exists must_change_password boolean not null default false;
alter table users add column if not exists phone text;

do $$ begin
  alter table users add constraint users_kind_chk check (kind in ('internal', 'external'));
exception when duplicate_object then null; end $$;

create unique index if not exists users_username_key on users (lower(username)) where username is not null;

-- legacy roles map onto system roles once
update users set system_role = case role
  when 'admin' then 'super_admin' when 'editor' then 'project_manager' when 'site' then 'engineer' else 'viewer' end
 where system_role = 'viewer' and role <> 'viewer';

create table if not exists roles (
  key         text primary key,
  label       text not null,
  kind        text not null check (kind in ('internal', 'external')),
  permissions text[] not null default '{}',
  builtin     boolean not null default true
);

insert into roles (key, label, kind, permissions) values
  ('super_admin',     'Super Admin',     'internal', array['*']),
  ('project_manager', 'Project Manager', 'internal', array['create:dev','create:cpm','create:props','view:financials']),
  ('finance',         'Finance',         'internal', array['view:financials','finance:post']),
  ('engineer',        'Engineer',        'internal', array[]::text[]),
  ('viewer',          'Viewer',          'internal', array[]::text[]),
  ('brokerage_agent', 'Brokerage Agent', 'internal', array['create:sales']),
  ('sales_manager',   'Sales Manager',   'internal', array['create:sales','view:financials']),
  ('external',        'External viewer', 'external', array[]::text[])
on conflict (key) do nothing;

-- ---------- sessions ----------
create table if not exists sessions (
  id           text primary key,                 -- sha256 of the cookie value
  user_id      uuid not null references users(id) on delete cascade,
  csrf         text not null,
  mfa_ok       boolean not null default false,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at   timestamptz not null,
  ip           text,
  user_agent   text
);
create index if not exists sessions_user on sessions (user_id);

create table if not exists password_resets (
  token_hash  text primary key,
  user_id     uuid not null references users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_at     timestamptz
);

-- ---------- numbering ----------
create table if not exists number_series (
  key        text primary key,      -- e.g. DEV-2026
  next_value integer not null default 1
);

-- ---------- parties (clients, owners, investors, buyers, sellers, suppliers…) ----------
create table if not exists parties (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null default 'person' check (kind in ('person', 'company')),
  name        text not null,
  email       text,
  phone       text,
  notes       text,
  roles       text[] not null default '{}',
  created_by  uuid references users(id) on delete set null,
  created_at  timestamptz not null default now(),
  archived_at timestamptz
);
create index if not exists parties_name on parties (lower(name));

-- ---------- workspaces ----------
create table if not exists workspaces (
  id          uuid primary key default gen_random_uuid(),
  section     text not null check (section in ('dev', 'cpm', 'props', 'sales')),
  kind        text not null,
  ref         text not null unique,
  name        text not null,
  status      text not null default 'active' check (status in ('active', 'on_hold', 'completed', 'archived')),
  stage       text,
  location    text,
  party_id    uuid references parties(id) on delete set null,
  manager_id  uuid references users(id) on delete set null,
  details     jsonb not null default '{}'::jsonb,
  legacy      boolean not null default false,
  created_by  uuid references users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  archived_at timestamptz,
  constraint workspaces_kind_chk check (
    (section = 'dev'   and kind = 'project') or
    (section = 'cpm'   and kind = 'client_project') or
    (section = 'props' and kind = 'property') or
    (section = 'sales' and kind in ('listing', 'request', 'deal')))
);
create index if not exists workspaces_section_status on workspaces (section, status);
create index if not exists workspaces_party on workspaces (party_id);

create table if not exists workspace_members (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id      uuid not null references users(id) on delete cascade,
  role         text not null check (role in ('manager', 'editor', 'contributor', 'viewer',
                 'client_viewer', 'owner_viewer', 'investor_viewer', 'seller_viewer', 'buyer_viewer', 'tenant')),
  grants       jsonb not null default '{}'::jsonb,
  added_by     uuid references users(id) on delete set null,
  added_at     timestamptz not null default now(),
  revoked_at   timestamptz,
  primary key (workspace_id, user_id)
);
create index if not exists workspace_members_user on workspace_members (user_id) where revoked_at is null;

-- ---------- files (stored in the database for now; storage adapter can move them later) ----------
create table if not exists files (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete restrict,
  entity        text,
  entity_id     text,
  original_name text not null,
  mime          text not null,
  size          integer not null,
  sha256        text not null,
  data          bytea not null,
  thumb         bytea,
  width         integer,
  height        integer,
  caption       text,
  location      text,
  observed_on   date,
  visibility    text not null default 'internal' check (visibility in ('internal', 'published')),
  version_of    uuid references files(id) on delete set null,
  uploaded_by   uuid references users(id) on delete set null,
  uploaded_at   timestamptz not null default now(),
  archived_at   timestamptz
);
create index if not exists files_workspace on files (workspace_id, uploaded_at desc);

-- ---------- outbox (emails; delivered only when SMTP is configured) ----------
create table if not exists outbox_messages (
  id           bigint generated always as identity primary key,
  to_address   text not null,
  subject      text not null,
  body_text    text,
  kind         text not null,
  sensitive    boolean not null default false,
  status       text not null default 'queued' check (status in ('queued', 'unconfigured', 'sent', 'failed')),
  attempts     integer not null default 0,
  provider_id  text,
  error        text,
  workspace_id uuid references workspaces(id) on delete set null,
  created_at   timestamptz not null default now(),
  sent_at      timestamptz
);

-- ---------- audit (append-only) ----------
create table if not exists audit_events (
  id           bigint generated always as identity primary key,
  at           timestamptz not null default now(),
  actor_id     uuid references users(id) on delete set null,
  actor_label  text,
  workspace_id uuid references workspaces(id) on delete set null,
  action       text not null,
  entity       text,
  entity_id    text,
  summary      text,
  before       jsonb,
  after        jsonb,
  ip           text
);
create index if not exists audit_events_ws on audit_events (workspace_id, id desc);
create index if not exists audit_events_at on audit_events (id desc);

create or replace function audit_events_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'audit_events is append-only';
end $$;
drop trigger if exists audit_events_no_change on audit_events;
create trigger audit_events_no_change before update or delete on audit_events
  for each row execute function audit_events_immutable();
