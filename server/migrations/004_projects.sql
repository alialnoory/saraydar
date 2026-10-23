-- Phase 3: project engine (used by SarayDar Real Estate Development; reused by Clients Projects Management in Phase 4).
-- Money is stored as integer minor units (BHD: 3 decimals) with an explicit currency. Never floating point.

create table if not exists setup_drafts (
  workspace_id uuid primary key references workspaces(id) on delete cascade,
  answers      jsonb not null default '{}'::jsonb,   -- { key: { "v": value, "unknown": bool } }
  step         text,
  status       text not null default 'draft' check (status in ('draft', 'reviewed')),
  updated_by   uuid references users(id) on delete set null,
  updated_at   timestamptz not null default now()
);

create table if not exists plans (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references workspaces(id) on delete cascade,
  version         integer not null,
  status          text not null default 'draft' check (status in ('draft', 'approved', 'superseded')),
  source          text not null default 'generated',  -- generated | imported | manual
  note            text,
  revision_reason text,
  baseline        jsonb,
  created_by      uuid references users(id) on delete set null,
  created_at      timestamptz not null default now(),
  approved_by     uuid references users(id) on delete set null,
  approved_at     timestamptz,
  unique (workspace_id, version)
);
create unique index if not exists plans_one_draft on plans (workspace_id) where status = 'draft';
create unique index if not exists plans_one_approved on plans (workspace_id) where status = 'approved';

create table if not exists phases (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references workspaces(id) on delete cascade,
  name             text not null,
  sort             integer not null default 0,
  weight           numeric(9,3) check (weight is null or weight >= 0),
  suggested_weight numeric(9,3),
  suggested        boolean not null default false,
  created_at       timestamptz not null default now(),
  archived_at      timestamptz
);
create index if not exists phases_ws on phases (workspace_id, sort);

create table if not exists tasks (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  phase_id      uuid references phases(id) on delete set null,
  parent_id     uuid references tasks(id) on delete set null,
  title         text not null,
  owner_text    text,
  owner_user    uuid references users(id) on delete set null,
  start_date    date,
  due_date      date,
  actual_start  date,
  actual_finish date,
  status        text not null default 'not_started' check (status in ('not_started', 'in_progress', 'blocked', 'done', 'cancelled')),
  progress      integer not null default 0 check (progress between 0 and 100),
  weight        numeric(9,3) check (weight is null or weight >= 0),
  is_milestone  boolean not null default false,
  notes         text,
  suggested     boolean not null default false,
  verified      boolean not null default true,       -- false for status reported at onboarding/import and not yet checked
  sort          integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  archived_at   timestamptz,
  constraint tasks_dates_chk check (start_date is null or due_date is null or due_date >= start_date)
);
create index if not exists tasks_ws on tasks (workspace_id, phase_id, sort);

create table if not exists task_deps (
  task_id    uuid not null references tasks(id) on delete cascade,
  depends_on uuid not null references tasks(id) on delete cascade,
  primary key (task_id, depends_on),
  check (task_id <> depends_on)
);

create table if not exists register_items (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  kind         text not null check (kind in ('risk', 'issue', 'decision', 'change', 'permit', 'stakeholder', 'procurement', 'quality', 'meeting', 'handover')),
  title        text not null,
  description  text,
  owner_text   text,
  status       text not null default 'open',
  likelihood   text check (likelihood is null or likelihood in ('Low', 'Medium', 'High')),
  impact       text check (impact is null or impact in ('Low', 'Medium', 'High')),
  due_date     date,
  extra        jsonb not null default '{}'::jsonb,
  suggested    boolean not null default false,
  created_by   uuid references users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  archived_at  timestamptz
);
create index if not exists register_ws on register_items (workspace_id, kind);

create table if not exists budget_lines (
  id                         uuid primary key default gen_random_uuid(),
  workspace_id               uuid not null references workspaces(id) on delete cascade,
  category                   text not null,
  description                text not null,
  currency                   text not null default 'BHD',
  original_minor             bigint,          -- set from the first approved baseline
  revised_minor              bigint,          -- current approved/working budget
  forecast_uncommitted_minor bigint,          -- cost still expected beyond commitments; null = not yet estimated
  source                     text not null default 'entered' check (source in ('entered', 'imported', 'suggested')),
  verified                   boolean not null default true,
  sort                       integer not null default 0,
  notes                      text,
  created_at                 timestamptz not null default now(),
  archived_at                timestamptz
);

create table if not exists commitments (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references workspaces(id) on delete cascade,
  budget_line_id uuid references budget_lines(id) on delete set null,
  counterparty   text not null,
  description    text,
  reference      text,
  committed_on   date,
  value_minor    bigint not null check (value_minor >= 0),
  currency       text not null default 'BHD',
  status         text not null default 'active' check (status in ('active', 'closed', 'cancelled')),
  source         text not null default 'entered',
  created_by     uuid references users(id) on delete set null,
  created_at     timestamptz not null default now()
);

create table if not exists cost_invoices (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references workspaces(id) on delete cascade,
  budget_line_id uuid references budget_lines(id) on delete set null,
  commitment_id  uuid references commitments(id) on delete set null,
  supplier       text not null,
  invoice_no     text,
  invoice_date   date,
  amount_minor   bigint not null check (amount_minor >= 0),
  currency       text not null default 'BHD',
  status         text not null default 'submitted' check (status in ('submitted', 'approved', 'rejected')),
  decided_by     uuid references users(id) on delete set null,
  decided_at     timestamptz,
  created_by     uuid references users(id) on delete set null,
  created_at     timestamptz not null default now()
);
create unique index if not exists cost_invoices_no_dup on cost_invoices (workspace_id, lower(supplier), invoice_no) where invoice_no is not null and status <> 'rejected';

create table if not exists cost_payments (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references workspaces(id) on delete cascade,
  budget_line_id uuid references budget_lines(id) on delete set null,
  invoice_id     uuid references cost_invoices(id) on delete set null,
  commitment_id  uuid references commitments(id) on delete set null,
  payee          text not null,
  payer          text not null default 'SarayDar',
  amount_minor   bigint not null check (amount_minor > 0),
  currency       text not null default 'BHD',
  paid_on        date,
  method         text,
  reference      text,
  notes          text,
  status         text not null default 'pending' check (status in ('pending', 'confirmed', 'reversed')),
  confirmed_by   uuid references users(id) on delete set null,
  confirmed_at   timestamptz,
  source         text not null default 'entered',
  created_by     uuid references users(id) on delete set null,
  created_at     timestamptz not null default now()
);

create table if not exists progress_updates (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references workspaces(id) on delete cascade,
  phase_id          uuid references phases(id) on delete set null,
  task_id           uuid references tasks(id) on delete set null,
  title             text not null,
  observed_on       date not null,
  completed_work    text,
  remaining_work    text,
  notes             text,
  issues            text,
  workforce         integer check (workforce is null or workforce >= 0),
  reported_progress integer check (reported_progress is null or reported_progress between 0 and 100),
  status            text not null default 'draft' check (status in ('draft', 'published')),
  external_visible  boolean not null default false,
  author_id         uuid references users(id) on delete set null,
  author_label      text,
  published_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  archived_at       timestamptz
);
create index if not exists progress_updates_ws on progress_updates (workspace_id, observed_on desc);

create table if not exists comments (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  entity       text not null,
  entity_id    uuid not null,
  body         text not null,
  author_id    uuid references users(id) on delete set null,
  created_at   timestamptz not null default now()
);
create index if not exists comments_entity on comments (entity, entity_id, created_at);

create table if not exists dev_units (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references workspaces(id) on delete cascade,
  name             text not null,
  unit_type        text,
  area_m2          numeric(10,2),
  status           text not null default 'available' check (status in ('planned', 'available', 'reserved', 'sold', 'handed_over', 'withdrawn')),
  list_price_minor bigint,
  currency         text not null default 'BHD',
  notes            text,
  sort             integer not null default 0,
  created_at       timestamptz not null default now()
);

create table if not exists app_state (key text primary key, value text not null);
