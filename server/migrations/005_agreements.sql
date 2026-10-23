-- Agreements & contracts for all four sections.

create table if not exists company_profile (
  id                 integer primary key default 1 check (id = 1),
  legal_name         text,
  trade_name         text,
  cr_number          text,
  address            text,
  phone              text,
  email              text,
  signatory_name     text,
  signatory_title    text,
  letterhead_mime    text,
  letterhead         bytea,      -- full-page A4 image (PNG/JPG) placed behind every page
  letterhead_name    text,
  margin_top_mm      integer not null default 45 check (margin_top_mm between 5 and 120),
  margin_bottom_mm   integer not null default 30 check (margin_bottom_mm between 5 and 120),
  updated_by         uuid references users(id) on delete set null,
  updated_at         timestamptz not null default now()
);
insert into company_profile (id, trade_name) values (1, 'SarayDar') on conflict do nothing;

alter table parties add column if not exists id_number text;            -- CPR / CR / passport, as provided
alter table parties add column if not exists address text;
alter table parties add column if not exists representative text;
alter table parties add column if not exists representative_title text;

create table if not exists agreement_templates (
  id                uuid primary key default gen_random_uuid(),
  key               text unique,                 -- set for built-in starter drafts
  name              text not null,
  sections          text[] not null,
  category          text not null,
  counterparty      text not null default 'Other party',
  kind              text not null check (kind in ('text', 'docx')),
  body              text,                         -- text templates
  docx              bytea,                        -- uploaded Word templates
  docx_name         text,
  fields            jsonb not null default '{}'::jsonb,
  version           integer not null default 1,
  starter           boolean not null default false,
  active            boolean not null default true,
  created_by        uuid references users(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create table if not exists agreements (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references workspaces(id) on delete restrict,
  template_id      uuid not null references agreement_templates(id) on delete restrict,
  ref              text not null unique,
  title            text not null,
  party_id         uuid references parties(id) on delete set null,
  values           jsonb not null default '{}'::jsonb,
  status           text not null default 'draft' check (status in ('draft', 'issued', 'signed', 'cancelled')),
  signed_on        date,
  cancel_reason    text,
  created_by       uuid references users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists agreements_ws on agreements (workspace_id, created_at desc);

create table if not exists agreement_versions (
  id               uuid primary key default gen_random_uuid(),
  agreement_id     uuid not null references agreements(id) on delete cascade,
  version          integer not null,
  template_version integer not null,
  values           jsonb not null,
  pdf              bytea,
  docx             bytea,
  created_by       uuid references users(id) on delete set null,
  created_at       timestamptz not null default now(),
  unique (agreement_id, version)
);
