-- Phase 5: Clients Properties Management.
-- Owner -> Property (workspace, section 'props') -> Unit -> leases, rent ledger, deposits, maintenance, expenses, history.
-- Money is integer minor units. Tenant rent, deposits, owner funds, property expenses and SarayDar fees are kept in
-- separate tables; owner statements are computed from them, never stored as free numbers.

create extension if not exists btree_gist;

-- ---------- property profile: how money and decisions flow (recorded, never assumed) ----------
create table if not exists property_profiles (
  workspace_id          uuid primary key references workspaces(id) on delete cascade,
  property_type         text check (property_type in ('residential_building', 'apartment', 'villa', 'commercial', 'mixed_use', 'other')),
  address               text,
  facilities            text,
  rent_collector        text not null default 'saraydar' check (rent_collector in ('saraydar', 'owner', 'other')),
  deposit_holder        text not null default 'saraydar' check (deposit_holder in ('saraydar', 'owner', 'other')),
  supplier_payer        text not null default 'saraydar' check (supplier_payer in ('saraydar', 'owner')),   -- saraydar = from funds held for the owner
  owner_transfers       text not null default 'saraydar' check (owner_transfers in ('saraydar', 'not_applicable')),
  fee_deduction_allowed boolean not null default false,
  maintenance_limit_minor bigint check (maintenance_limit_minor >= 0),     -- per job without prior owner approval; null = every job needs owner approval
  emergency_allowed     boolean not null default false,
  emergency_limit_minor bigint check (emergency_limit_minor >= 0),
  reserve_minor         bigint not null default 0 check (reserve_minor >= 0),     -- agreed amount kept back from owner transfers
  owner_approval_rules  text,
  reporting_prefs       text,
  payment_instructions  text,                                             -- printed on rent invoices (bank details etc.)
  billing_entity        text not null default 'owner' check (billing_entity in ('owner', 'saraydar')),  -- who rent invoices are issued in the name of
  updated_by            uuid references users(id) on delete set null,
  updated_at            timestamptz not null default now()
);

create table if not exists property_owners (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  party_id     uuid not null references parties(id) on delete restrict,
  share_pct    numeric(6,3) check (share_pct > 0 and share_pct <= 100),
  statement_rule text,
  is_primary   boolean not null default false,
  created_at   timestamptz not null default now(),
  unique (workspace_id, party_id)
);

-- ---------- units ----------
create table if not exists units (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete restrict,
  ref          text not null,
  floor        text,
  unit_type    text,
  area_m2      numeric(10,2) check (area_m2 >= 0),
  bedrooms     integer check (bedrooms >= 0),
  features     text,
  condition    text,
  status       text not null default 'available' check (status in ('available', 'reserved', 'occupied', 'maintenance', 'unavailable')),
  market_rent_minor bigint check (market_rent_minor >= 0),
  notes        text,
  sort         integer not null default 0,
  created_at   timestamptz not null default now(),
  archived_at  timestamptz
);
create unique index if not exists units_ref on units (workspace_id, lower(ref)) where archived_at is null;
create table if not exists unit_status_history (
  id         bigint generated always as identity primary key,
  unit_id    uuid not null references units(id) on delete cascade,
  status     text not null,
  changed_on date not null,
  reason     text,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);

-- ---------- leases ----------
create table if not exists leases (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references workspaces(id) on delete restrict,
  unit_id         uuid not null references units(id) on delete restrict,
  tenant_id       uuid not null references parties(id) on delete restrict,
  ref             text not null unique,
  status          text not null default 'draft' check (status in ('draft', 'active', 'ended', 'terminated', 'cancelled')),
  start_date      date not null,
  end_date        date not null,
  terminated_on   date,
  termination_reason text,
  move_in_date    date,
  move_out_date   date,
  rent_minor      bigint not null check (rent_minor >= 0),               -- monthly rent at the start; changes are in lease_rent_steps
  frequency_months integer not null default 1 check (frequency_months in (1, 3, 6, 12)),
  proration       text not null default 'daily' check (proration in ('daily', 'none')),
  due_day_offset  integer not null default 0 check (due_day_offset between 0 and 60),   -- days after the period start
  deposit_minor   bigint not null default 0 check (deposit_minor >= 0),
  occupants       text,
  contact_notes   text,
  renewal_of      uuid references leases(id) on delete set null,
  agreement_id    uuid references agreements(id) on delete set null,
  source          text not null default 'entered' check (source in ('entered', 'opening')),
  -- automated invoicing (off until an authorised user enables it)
  auto_invoice    boolean not null default false,
  invoice_days_before integer not null default 0 check (invoice_days_before between 0 and 31),
  delivery        text not null default 'email' check (delivery in ('email', 'none')),
  reminder_days   integer[] not null default '{3,10}',
  auto_from       date,                                                -- first period start invoiced automatically
  auto_enabled_by uuid references users(id) on delete set null,
  auto_enabled_at timestamptz,
  notes           text,
  created_by      uuid references users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  check (end_date >= start_date),
  check (terminated_on is null or (terminated_on >= start_date and terminated_on <= end_date))
);
-- no two effective leases for the same unit may overlap (renewals start after the previous lease ends)
alter table leases drop constraint if exists leases_no_overlap;
alter table leases add constraint leases_no_overlap exclude using gist (
  unit_id with =, daterange(start_date, coalesce(terminated_on, end_date), '[]') with &&
) where (status in ('active', 'ended', 'terminated'));

create table if not exists lease_rent_steps (
  id             uuid primary key default gen_random_uuid(),
  lease_id       uuid not null references leases(id) on delete cascade,
  effective_from date not null,
  rent_minor     bigint not null check (rent_minor >= 0),
  reason         text,
  created_by     uuid references users(id) on delete set null,
  created_at     timestamptz not null default now(),
  unique (lease_id, effective_from)
);
create table if not exists lease_charges (                            -- authorised recurring charges (service charge, parking…)
  id           uuid primary key default gen_random_uuid(),
  lease_id     uuid not null references leases(id) on delete cascade,
  description  text not null,
  amount_minor bigint not null check (amount_minor > 0),               -- per month
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);
create table if not exists lease_events (                             -- move-in/out inspections, keys, meters, renewals, notices
  id          uuid primary key default gen_random_uuid(),
  lease_id    uuid not null references leases(id) on delete cascade,
  kind        text not null check (kind in ('move_in', 'move_out', 'inspection', 'keys', 'meter', 'notice', 'amendment', 'other')),
  on_date     date not null,
  details     text,
  created_by  uuid references users(id) on delete set null,
  created_at  timestamptz not null default now()
);

-- ---------- rent ledger ----------
create table if not exists rent_invoices (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete restrict,
  lease_id      uuid not null references leases(id) on delete restrict,
  number        text not null unique,
  period_start  date not null,
  period_end    date not null,
  issue_date    date not null,
  due_date      date not null,
  total_minor   bigint not null check (total_minor >= 0),
  currency      text not null default 'BHD',
  status        text not null default 'issued' check (status in ('issued', 'void')),
  origin        text not null default 'manual' check (origin in ('manual', 'scheduler')),
  void_reason   text,
  created_by    uuid references users(id) on delete set null,
  created_at    timestamptz not null default now()
);
create unique index if not exists rent_invoices_one_per_period on rent_invoices (lease_id, period_start) where status <> 'void';

create table if not exists rent_charges (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete restrict,
  lease_id      uuid not null references leases(id) on delete restrict,
  unit_id       uuid not null references units(id) on delete restrict,
  kind          text not null check (kind in ('rent', 'charge', 'opening', 'other')),
  charge_key    text not null,                                          -- 'rent' or the lease_charges id; makes generation idempotent
  description   text not null,
  period_start  date not null,
  period_end    date not null,
  due_date      date not null,
  amount_minor  bigint not null check (amount_minor >= 0),
  status        text not null default 'open' check (status in ('open', 'void')),
  invoice_id    uuid references rent_invoices(id) on delete set null,
  opening_id    uuid,
  void_reason   text,
  created_by    uuid references users(id) on delete set null,
  created_at    timestamptz not null default now()
);
create unique index if not exists rent_charges_once on rent_charges (lease_id, charge_key, period_start) where status <> 'void';

create table if not exists tenant_payments (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete restrict,
  lease_id      uuid not null references leases(id) on delete restrict,
  received_on   date not null,
  amount_minor  bigint not null check (amount_minor > 0),
  currency      text not null default 'BHD',
  method        text not null,
  reference     text,
  cheque_date   date,
  received_by   text not null check (received_by in ('saraydar', 'owner', 'other')),
  status        text not null default 'reported' check (status in ('reported', 'confirmed', 'bounced', 'reversed')),
  notes         text,
  idem_key      text unique,
  recorded_by   uuid references users(id) on delete set null,
  recorded_at   timestamptz not null default now(),
  confirmed_by  uuid references users(id) on delete set null,
  confirmed_at  timestamptz,
  cleared_on    date,
  receipt_no    text unique,
  receipt_issued_at timestamptz,
  receipt_issued_by uuid references users(id) on delete set null,
  reversed_at   timestamptz,
  reverse_reason text
);
create unique index if not exists tenant_payments_no_dup on tenant_payments (workspace_id, lower(method), lower(reference)) where reference is not null and status in ('reported', 'confirmed');

create table if not exists tenant_allocations (
  id           uuid primary key default gen_random_uuid(),
  payment_id   uuid not null references tenant_payments(id) on delete restrict,
  charge_id    uuid not null references rent_charges(id) on delete restrict,
  amount_minor bigint not null check (amount_minor > 0),
  status       text not null default 'active' check (status in ('active', 'reversed')),
  created_by   uuid references users(id) on delete set null,
  created_at   timestamptz not null default now(),
  reversed_at  timestamptz,
  reverse_reason text
);
create index if not exists tenant_allocations_charge on tenant_allocations (charge_id) where status = 'active';

create table if not exists rent_credits (                             -- approved credit notes against a charge
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete restrict,
  charge_id    uuid not null references rent_charges(id) on delete restrict,
  number       text not null unique,
  on_date      date not null,
  amount_minor bigint not null check (amount_minor > 0),
  reason       text not null,
  created_by   uuid references users(id) on delete set null,
  created_at   timestamptz not null default now()
);

-- ---------- deposits: never rent income or owner funds until released under authorisation ----------
create table if not exists deposit_txns (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete restrict,
  lease_id     uuid not null references leases(id) on delete restrict,
  kind         text not null check (kind in ('received', 'deduction', 'refund')),
  on_date      date not null,
  amount_minor bigint not null check (amount_minor > 0),
  holder       text not null check (holder in ('saraydar', 'owner', 'other')),
  reason       text,
  approval_ref text,
  reference    text,
  source       text not null default 'entered' check (source in ('entered', 'opening')),
  opening_id   uuid,
  created_by   uuid references users(id) on delete set null,
  created_at   timestamptz not null default now()
);

-- ---------- owner account entries recorded by staff (everything else is computed) ----------
create table if not exists owner_txns (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete restrict,
  kind          text not null check (kind in ('contribution', 'transfer', 'fee_deduction', 'opening_cash')),
  on_date       date not null,
  amount_minor  bigint not null check (amount_minor > 0),
  reference     text,
  notes         text,
  fee_invoice_id uuid references fee_invoices(id) on delete restrict,
  fee_payment_id uuid unique references fee_payments(id) on delete restrict,
  opening_id    uuid,
  status        text not null default 'recorded' check (status in ('recorded', 'reversed')),
  reverse_reason text,
  created_by    uuid references users(id) on delete set null,
  created_at    timestamptz not null default now()
);

-- ---------- opening balances: reviewed and approved before posting; posted once ----------
create table if not exists opening_balances (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete restrict,
  kind         text not null check (kind in ('tenant_arrears', 'deposit_held', 'owner_cash')),
  lease_id     uuid references leases(id) on delete restrict,
  as_of        date not null,
  amount_minor bigint not null check (amount_minor > 0),
  holder       text,
  evidence     text,
  verified     boolean not null default false,
  status       text not null default 'draft' check (status in ('draft', 'approved', 'posted', 'rejected')),
  approved_by  uuid references users(id) on delete set null,
  approved_at  timestamptz,
  posted_at    timestamptz,
  created_by   uuid references users(id) on delete set null,
  created_at   timestamptz not null default now(),
  check (kind = 'owner_cash' or lease_id is not null)
);
create unique index if not exists opening_once_per_lease on opening_balances (lease_id, kind) where status <> 'rejected' and lease_id is not null;
create unique index if not exists opening_owner_once on opening_balances (workspace_id) where kind = 'owner_cash' and status <> 'rejected';
create unique index if not exists rent_charges_opening on rent_charges (opening_id) where opening_id is not null;
create unique index if not exists deposit_opening on deposit_txns (opening_id) where opening_id is not null;
create unique index if not exists owner_opening on owner_txns (opening_id) where opening_id is not null;

-- ---------- providers, maintenance, expenses ----------

create table if not exists maint_requests (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references workspaces(id) on delete restrict,
  unit_id         uuid references units(id) on delete restrict,         -- null = common area
  location        text,
  ref             text not null unique,
  kind            text not null default 'reactive' check (kind in ('reactive', 'preventive', 'inspection', 'warranty')),
  category        text not null,
  title           text not null,
  description     text,
  priority        text not null default 'normal' check (priority in ('low', 'normal', 'high', 'emergency')),
  reported_on     date not null,
  reported_by     text,                                                -- tenant / owner / staff, as told
  provider        text,
  target_date     date,
  status          text not null default 'open' check (status in ('open', 'assigned', 'awaiting_approval', 'approved', 'in_progress', 'completed', 'verified', 'closed', 'cancelled', 'rejected')),
  estimate_minor  bigint check (estimate_minor >= 0),
  approval        text not null default 'none' check (approval in ('none', 'within_limit', 'owner_approved', 'emergency', 'owner_rejected')),
  approval_ref    text,
  approval_note   text,
  approved_by     uuid references users(id) on delete set null,
  approved_at     timestamptz,
  responsible     text not null default 'undecided' check (responsible in ('undecided', 'owner', 'tenant', 'saraydar', 'other')),
  responsibility_note text,
  started_on      date,
  completed_on    date,
  verified_by     uuid references users(id) on delete set null,
  verified_on     date,
  warranty_until  date,
  notes           text,
  created_by      uuid references users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists maint_ws on maint_requests (workspace_id, status);

create table if not exists prop_expenses (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references workspaces(id) on delete restrict,
  unit_id         uuid references units(id) on delete restrict,         -- null = shared / building cost
  maint_id        uuid references maint_requests(id) on delete set null,
  category        text not null,
  description     text not null,
  supplier        text not null,
  invoice_no      text,
  incurred_on     date not null,
  amount_minor    bigint not null check (amount_minor > 0),
  allocation      text not null default 'unit' check (allocation in ('unit', 'equal', 'area', 'none')),
  responsible     text not null default 'owner' check (responsible in ('owner', 'tenant', 'saraydar', 'other')),
  status          text not null default 'submitted' check (status in ('submitted', 'approved', 'rejected')),
  approved_by     uuid references users(id) on delete set null,
  approved_at     timestamptz,
  paid_by         text check (paid_by in ('saraydar_held_funds', 'owner_direct', 'tenant', 'saraydar_own', 'other')),
  pay_status      text not null default 'unpaid' check (pay_status in ('unpaid', 'pending', 'paid', 'reversed')),
  paid_on         date,
  pay_reference   text,
  pay_confirmed_by uuid references users(id) on delete set null,
  notes           text,
  created_by      uuid references users(id) on delete set null,
  created_at      timestamptz not null default now()
);
create unique index if not exists prop_expenses_no_dup on prop_expenses (workspace_id, lower(supplier), invoice_no) where invoice_no is not null and status <> 'rejected';
create table if not exists expense_allocations (
  id           uuid primary key default gen_random_uuid(),
  expense_id   uuid not null references prop_expenses(id) on delete cascade,
  unit_id      uuid not null references units(id) on delete restrict,
  amount_minor bigint not null check (amount_minor >= 0),
  basis        text not null,
  unique (expense_id, unit_id)
);

-- ---------- cleaning and routine services ----------
create table if not exists service_schedules (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete restrict,
  unit_id      uuid references units(id) on delete restrict,
  location     text,
  title        text not null,
  provider     text,
  frequency    text not null check (frequency in ('weekly', 'fortnightly', 'monthly', 'quarterly')),
  start_date   date not null,
  checklist    text,
  cost_minor   bigint check (cost_minor >= 0),
  active       boolean not null default true,
  created_by   uuid references users(id) on delete set null,
  created_at   timestamptz not null default now()
);
create table if not exists service_tasks (
  id           uuid primary key default gen_random_uuid(),
  schedule_id  uuid not null references service_schedules(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete restrict,
  scheduled_on date not null,
  status       text not null default 'scheduled' check (status in ('scheduled', 'done', 'reviewed', 'missed', 'cancelled')),
  completed_on date,
  notes        text,
  reviewed_by  uuid references users(id) on delete set null,
  created_at   timestamptz not null default now(),
  unique (schedule_id, scheduled_on)
);

-- ---------- background jobs and delivery tracking ----------
create table if not exists job_runs (
  id          bigint generated always as identity primary key,
  job         text not null,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  status      text not null default 'running' check (status in ('running', 'ok', 'failed', 'skipped')),
  summary     text,
  error       text
);
create table if not exists rent_reminders (
  invoice_id  uuid not null references rent_invoices(id) on delete cascade,
  day_offset  integer not null,
  sent_at     timestamptz not null default now(),
  outbox_id   bigint,
  primary key (invoice_id, day_offset)
);
