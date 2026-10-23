-- Profile photos, extra user details, and multiple plots per project.

alter table users add column if not exists job_title text;

create table if not exists user_photos (
  user_id    uuid primary key references users(id) on delete cascade,
  mime       text not null,
  data       bytea not null,
  updated_at timestamptz not null default now()
);

create table if not exists plots (
  id                   uuid primary key default gen_random_uuid(),
  workspace_id         uuid not null references workspaces(id) on delete cascade,
  ref                  text not null,                 -- plot number as used by the owner / survey
  title_deed           text,
  area_m2              numeric(12,2) check (area_m2 is null or area_m2 >= 0),
  frontage_m           numeric(9,2) check (frontage_m is null or frontage_m >= 0),
  depth_m              numeric(9,2) check (depth_m is null or depth_m >= 0),
  location             text,
  tenure               text check (tenure is null or tenure in ('freehold', 'leasehold', 'other')),
  owner_text           text,
  zoning               text,
  status               text not null default 'owned' check (status in ('owned', 'under_purchase', 'option', 'client_owned', 'sold')),
  purchase_price_minor bigint check (purchase_price_minor is null or purchase_price_minor >= 0),
  currency             text not null default 'BHD',
  purchase_date        date,
  notes                text,
  sort                 integer not null default 0,
  created_at           timestamptz not null default now(),
  archived_at          timestamptz
);
create unique index if not exists plots_ref_unique on plots (workspace_id, lower(ref)) where archived_at is null;

alter table dev_units add column if not exists plot_id uuid references plots(id) on delete set null;
