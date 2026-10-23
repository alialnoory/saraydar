-- Phase 4: Clients Projects Management.
-- Client profiles, management-agreement terms (versioned), SarayDar's fee ledger (invoices, credit notes,
-- payments, allocations, receipts), client-funded expenditure details and externally obtained client approvals.
-- The fee ledger is completely separate from the client's construction budget/expenditure tables.

-- ---------- client profile (clients are parties with the 'client' role) ----------
alter table parties add column if not exists contact_person       text;
alter table parties add column if not exists representatives      text;   -- authorised representatives, one per line
alter table parties add column if not exists preferred_contact    text;
alter table parties add column if not exists billing_name         text;
alter table parties add column if not exists billing_address      text;
alter table parties add column if not exists billing_email        text;
alter table parties add column if not exists tax_number           text;
alter table parties add column if not exists client_reference     text;
alter table parties add column if not exists approval_authorities text;
alter table parties add column if not exists communication_notes  text;
alter table parties add column if not exists updated_at           timestamptz;

create table if not exists party_correspondence (
  id          uuid primary key default gen_random_uuid(),
  party_id    uuid not null references parties(id) on delete cascade,
  workspace_id uuid references workspaces(id) on delete set null,
  kind        text not null check (kind in ('call', 'email', 'meeting', 'letter', 'message', 'other')),
  occurred_on date not null,
  summary     text not null,
  created_by  uuid references users(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index if not exists party_correspondence_party on party_correspondence (party_id, occurred_on desc);

-- ---------- management agreement terms: each change is a new version; old versions are kept ----------
create table if not exists mgmt_terms (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid not null references workspaces(id) on delete restrict,
  version            integer not null,
  status             text not null default 'draft' check (status in ('draft', 'active', 'superseded', 'withdrawn')),
  agreement_ref      text,
  signed_on          date,
  start_date         date not null,
  end_date           date,
  effective_from     date not null,
  scope              text,
  responsibilities   text,
  exclusions         text,
  monthly_fee_minor  bigint not null check (monthly_fee_minor >= 0),
  currency           text not null default 'BHD',
  billing_timing     text not null default 'advance' check (billing_timing in ('advance', 'arrears')),
  proration          text not null default 'daily' check (proration in ('daily', 'none')),
  payment_terms_days integer not null default 30 check (payment_terms_days between 0 and 365),
  tax_mode           text not null default 'not_configured' check (tax_mode in ('not_configured', 'none', 'rate')),
  tax_rate_bp        integer check (tax_rate_bp between 0 and 10000),      -- basis points: 1000 = 10%
  tax_label          text,
  client_approvers   text,
  auto_issue         boolean not null default false,                      -- recorded only; automatic issuing is not enabled in this version
  notes              text,
  created_by         uuid references users(id) on delete set null,
  created_at         timestamptz not null default now(),
  activated_by       uuid references users(id) on delete set null,
  activated_at       timestamptz,
  unique (workspace_id, version),
  check (end_date is null or end_date >= start_date),
  check (effective_from >= start_date)
);
create unique index if not exists mgmt_terms_one_draft on mgmt_terms (workspace_id) where status = 'draft';

-- ---------- fee invoices ----------
create table if not exists fee_invoices (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references workspaces(id) on delete restrict,
  party_id       uuid references parties(id) on delete set null,
  number         text unique,                               -- assigned when issued
  kind           text not null default 'monthly' check (kind in ('monthly', 'additional')),
  status         text not null default 'draft' check (status in ('draft', 'issued', 'void')),
  period_start   date,
  period_end     date,
  issue_date     date,
  due_date       date,
  currency       text not null default 'BHD',
  subtotal_minor bigint not null default 0,
  tax_minor      bigint not null default 0,
  total_minor    bigint not null default 0 check (total_minor >= 0),
  tax_mode       text,
  tax_rate_bp    integer,
  tax_label      text,
  terms_id       uuid references mgmt_terms(id) on delete restrict,
  notes          text,
  created_by     uuid references users(id) on delete set null,
  created_at     timestamptz not null default now(),
  issued_by      uuid references users(id) on delete set null,
  issued_at      timestamptz,
  voided_by      uuid references users(id) on delete set null,
  voided_at      timestamptz,
  void_reason    text,
  check (period_end is null or period_end >= period_start)
);
-- one monthly invoice per billing period (a voided one can be replaced)
create unique index if not exists fee_invoices_one_per_period on fee_invoices (workspace_id, period_start) where kind = 'monthly' and status <> 'void';
create index if not exists fee_invoices_ws on fee_invoices (workspace_id, status);

create table if not exists fee_invoice_lines (
  id           uuid primary key default gen_random_uuid(),
  invoice_id   uuid not null references fee_invoices(id) on delete cascade,
  kind         text not null default 'fee' check (kind in ('fee', 'additional', 'adjustment')),
  description  text not null,
  amount_minor bigint not null,
  sort         integer not null default 0
);

create table if not exists fee_credit_notes (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete restrict,
  invoice_id   uuid not null references fee_invoices(id) on delete restrict,
  number       text not null unique,
  issued_on    date not null,
  amount_minor bigint not null check (amount_minor > 0),
  reason       text not null,
  created_by   uuid references users(id) on delete set null,
  created_at   timestamptz not null default now()
);

-- ---------- client payments of SarayDar fees, allocations and receipts ----------
create table if not exists fee_payments (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references workspaces(id) on delete restrict,
  party_id          uuid references parties(id) on delete set null,
  received_on       date not null,
  amount_minor      bigint not null check (amount_minor > 0),
  currency          text not null default 'BHD',
  method            text not null,
  reference         text,
  notes             text,
  status            text not null default 'confirmed' check (status in ('confirmed', 'reversed')),
  idem_key          text unique,                     -- one form submission records one payment
  recorded_by       uuid references users(id) on delete set null,
  recorded_at       timestamptz not null default now(),
  receipt_no        text unique,
  receipt_issued_by uuid references users(id) on delete set null,
  receipt_issued_at timestamptz,
  reversed_by       uuid references users(id) on delete set null,
  reversed_at       timestamptz,
  reverse_reason    text
);
create unique index if not exists fee_payments_no_dup_ref on fee_payments (workspace_id, lower(method), lower(reference)) where reference is not null and status = 'confirmed';

create table if not exists fee_allocations (
  id           uuid primary key default gen_random_uuid(),
  payment_id   uuid not null references fee_payments(id) on delete restrict,
  invoice_id   uuid not null references fee_invoices(id) on delete restrict,
  amount_minor bigint not null check (amount_minor > 0),
  status       text not null default 'active' check (status in ('active', 'reversed')),
  created_by   uuid references users(id) on delete set null,
  created_at   timestamptz not null default now(),
  reversed_by  uuid references users(id) on delete set null,
  reversed_at  timestamptz,
  reverse_reason text
);
create index if not exists fee_allocations_inv on fee_allocations (invoice_id) where status = 'active';
create index if not exists fee_allocations_pay on fee_allocations (payment_id) where status = 'active';

-- ---------- client-funded expenditure details ----------
alter table commitments add column if not exists kind text not null default 'contract';
alter table cost_invoices add column if not exists doc_type text not null default 'invoice';
alter table cost_invoices add column if not exists reviewed_by uuid references users(id) on delete set null;
alter table cost_invoices add column if not exists reviewed_at timestamptz;
alter table cost_invoices drop constraint if exists cost_invoices_status_check;
alter table cost_invoices add constraint cost_invoices_status_check check (status in ('submitted', 'reviewed', 'approved', 'rejected'));
alter table cost_payments add column if not exists on_behalf boolean not null default false;   -- SarayDar pays for the client: exceptional
alter table cost_payments add column if not exists approval_ref text;

-- ---------- client approvals obtained outside the system ----------
create table if not exists client_approvals (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete restrict,
  subject       text not null check (subject in ('budget', 'appointment', 'material', 'variation', 'payment', 'design', 'other')),
  title         text not null,
  linked_ref    text,                 -- e.g. "Budget v2", "Variation VO-03", drawing revision
  requested_on  date not null,
  requested_from text,                -- the client approver asked
  status        text not null default 'requested' check (status in ('requested', 'approved', 'rejected', 'withdrawn')),
  decided_on    date,
  approver_name text,                 -- the person who actually decided (external)
  method        text,                 -- signed letter, email, meeting minutes, message…
  notes         text,                 -- internal
  client_visible boolean not null default true,
  created_by    uuid references users(id) on delete set null,
  created_at    timestamptz not null default now(),
  decided_by    uuid references users(id) on delete set null,   -- staff member who recorded the decision
  decided_at    timestamptz
);
create index if not exists client_approvals_ws on client_approvals (workspace_id, requested_on desc);
