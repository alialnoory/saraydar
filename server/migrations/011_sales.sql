-- Phase 6: Property Sales & Acquisition.
-- Listings (workspace kind 'listing'), acquisition requests (kind 'request') and deals (kind 'deal').
-- Mandate status and listing status are separate. Prices and offers keep full history. SarayDar fees are
-- billed on the shared fee ledger; gross deal value is never SarayDar revenue.

-- ---------- mandates (sale agreement for a listing / acquisition agreement for a request), versioned ----------
create table if not exists sale_mandates (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references workspaces(id) on delete restrict,
  version          integer not null,
  status           text not null default 'draft' check (status in ('draft', 'active', 'suspended', 'terminated', 'superseded', 'completed')),
  side             text not null check (side in ('seller', 'buyer')),
  party_id         uuid references parties(id) on delete set null,          -- appointing client
  scope            text,
  exclusive        text not null default 'unknown' check (exclusive in ('exclusive', 'non_exclusive', 'unknown')),
  start_date       date not null,
  end_date         date,
  renewal_terms    text,
  price_authority  text,            -- seller: asking-price authority; buyer: purchasing constraints
  marketing_scope  text,
  marketing_budget_minor bigint check (marketing_budget_minor >= 0),
  fee_type         text not null default 'none' check (fee_type in ('none', 'fixed', 'percent')),
  fee_fixed_minor  bigint check (fee_fixed_minor >= 0),
  fee_bp           integer check (fee_bp between 0 and 10000),           -- basis points of the calculation base
  fee_base         text not null default 'final_price' check (fee_base in ('final_price', 'accepted_price')),
  fee_payer        text,
  fee_trigger      text not null default 'completion' check (fee_trigger in ('completion', 'signing', 'other')),
  tax_mode         text not null default 'none' check (tax_mode in ('none', 'rate', 'not_configured')),
  tax_rate_bp      integer check (tax_rate_bp between 0 and 10000),
  tax_label        text,
  payment_terms_days integer not null default 15 check (payment_terms_days between 0 and 365),
  dual_representation text,         -- documented arrangement, empty = SarayDar acts for this side only
  co_broker        text,            -- documented co-broker / referral split
  client_decisions text,            -- decisions the client must take externally
  agreement_id     uuid references agreements(id) on delete set null,
  authority_verified_by uuid references users(id) on delete set null,
  authority_verified_at timestamptz,
  authority_evidence text,
  status_reason    text,
  created_by       uuid references users(id) on delete set null,
  created_at       timestamptz not null default now(),
  unique (workspace_id, version)
);
create unique index if not exists sale_mandates_one_draft on sale_mandates (workspace_id) where status = 'draft';
create unique index if not exists sale_mandates_one_active on sale_mandates (workspace_id) where status in ('active', 'suspended');

-- ---------- listing file ----------
create table if not exists listings (
  workspace_id     uuid primary key references workspaces(id) on delete cascade,
  status           text not null default 'draft' check (status in ('draft', 'awaiting_verification', 'ready', 'available', 'under_offer', 'reserved', 'sold', 'withdrawn', 'archived')),
  property_type    text,
  category         text,
  location         text,
  map_ref          text,
  land_area_m2     numeric(12,2),
  built_area_m2    numeric(12,2),
  unit_floor       text,
  bedrooms         integer,
  bathrooms        integer,
  features         text,
  condition        text,
  occupancy        text,
  access_notes     text,              -- internal: keys, contact for viewings
  title_info       text,              -- confidential
  restrictions     text,
  asking_minor     bigint check (asking_minor >= 0),
  currency         text not null default 'BHD',
  negotiable       text not null default 'unknown' check (negotiable in ('yes', 'no', 'unknown')),
  min_price_minor  bigint check (min_price_minor >= 0),              -- confidential: never shown to buyers
  description      text,              -- public / client-approved
  source           text,
  verification     text not null default 'unverified' check (verification in ('unverified', 'verified')),
  verified_by      uuid references users(id) on delete set null,
  verified_at      timestamptz,
  linked_unit_id   uuid references units(id) on delete set null,     -- cross-link to a managed unit (no automatic effect on its lease)
  available_since  date,
  updated_at       timestamptz not null default now()
);
create table if not exists listing_prices (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  asking_minor  bigint not null check (asking_minor >= 0),
  currency      text not null default 'BHD',
  effective_on  date not null,
  reason        text,
  seller_approval text,
  created_by    uuid references users(id) on delete set null,
  created_at    timestamptz not null default now()
);
create table if not exists listing_status_history (
  id            bigint generated always as identity primary key,
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  status        text not null,
  changed_on    date not null,
  reason        text,
  evidence      text,
  created_by    uuid references users(id) on delete set null,
  created_at    timestamptz not null default now()
);
create table if not exists marketing_activities (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  channel       text not null,
  reference     text,
  url           text,
  status        text not null default 'planned' check (status in ('planned', 'published', 'ended', 'cancelled')),
  published_on  date,
  ended_on      date,
  evidence      text,               -- required to record "published"
  description   text,
  cost_minor    bigint check (cost_minor >= 0),
  results       text,
  agent_id      uuid references users(id) on delete set null,
  created_by    uuid references users(id) on delete set null,
  created_at    timestamptz not null default now()
);

-- ---------- contacts / CRM ----------
alter table parties add column if not exists preferred_language text;
alter table parties add column if not exists lead_source text;
alter table parties add column if not exists agent_id uuid references users(id) on delete set null;
alter table parties add column if not exists merged_into uuid references parties(id) on delete set null;

create table if not exists buyer_profiles (
  party_id       uuid primary key references parties(id) on delete cascade,
  status         text not null default 'active' check (status in ('active', 'on_hold', 'closed')),
  purpose        text,
  types          text,
  locations      text,
  budget_min_minor bigint, budget_max_minor bigint,
  currency       text not null default 'BHD',
  size_min_m2    numeric(12,2), size_max_m2 numeric(12,2),
  bedrooms_min   integer,
  timing         text,
  funding        text,
  unknown        text[] not null default '{}',                     -- fields the buyer has not said
  notes          text,
  updated_at     timestamptz not null default now()
);
create table if not exists opportunities (
  id             uuid primary key default gen_random_uuid(),
  party_id       uuid not null references parties(id) on delete restrict,
  listing_ws     uuid references workspaces(id) on delete restrict,
  request_ws     uuid references workspaces(id) on delete restrict,
  stage          text not null default 'new' check (stage in ('new', 'contacted', 'qualified', 'matched', 'viewing_arranged', 'viewing_completed', 'negotiation', 'in_progress', 'won', 'lost', 'on_hold')),
  source         text,
  agent_id       uuid references users(id) on delete set null,
  next_action    text,
  next_followup_on date,
  no_followup_reason text,
  lost_reason    text,
  last_contact_on date,
  created_by     uuid references users(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create unique index if not exists opportunities_once on opportunities (party_id, listing_ws) where listing_ws is not null;
create table if not exists crm_activities (
  id             uuid primary key default gen_random_uuid(),
  party_id       uuid not null references parties(id) on delete restrict,
  opportunity_id uuid references opportunities(id) on delete set null,
  workspace_id   uuid references workspaces(id) on delete set null,
  kind           text not null check (kind in ('call', 'meeting', 'message', 'email', 'note', 'promise')),
  occurred_on    date not null,
  summary        text not null,
  outcome        text,
  next_followup_on date,
  agent_id       uuid references users(id) on delete set null,
  created_by     uuid references users(id) on delete set null,
  created_at     timestamptz not null default now()
);

-- ---------- acquisition requests ----------
create table if not exists acq_requests (
  workspace_id   uuid primary key references workspaces(id) on delete cascade,
  status         text not null default 'draft' check (status in ('draft', 'brief_confirmed', 'searching', 'shortlist_shared', 'viewings', 'negotiation', 'transaction', 'completed', 'on_hold', 'closed_unsuccessful')),
  status_reason  text,
  updated_at     timestamptz not null default now()
);
create table if not exists request_briefs (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references workspaces(id) on delete cascade,
  version        integer not null,
  purpose        text,
  types          text,                 -- comma-separated property types
  locations      text,                 -- comma-separated areas
  budget_min_minor bigint, budget_max_minor bigint,
  currency       text not null default 'BHD',
  flexibility_pct numeric(5,2),
  land_min_m2 numeric(12,2), land_max_m2 numeric(12,2),
  built_min_m2 numeric(12,2), built_max_m2 numeric(12,2),
  bedrooms_min   integer,
  features       text,
  condition      text,
  yield_note     text,                 -- only if the client supplied it
  timing         text,
  funding        text,
  exclusions     text,
  decision_makers text,
  unknown        text[] not null default '{}',
  change_reason  text,
  evidence       text,
  created_by     uuid references users(id) on delete set null,
  created_at     timestamptz not null default now(),
  unique (workspace_id, version)
);
create table if not exists external_opps (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references workspaces(id) on delete cascade,     -- the request
  title          text not null,
  source         text not null,
  source_contact text,
  property_type  text,
  location       text,
  price_minor    bigint,
  currency       text not null default 'BHD',
  land_area_m2   numeric(12,2), built_area_m2 numeric(12,2), bedrooms integer,
  verification   text not null default 'unverified' check (verification in ('unverified', 'verified')),
  checked_on     date,
  availability   text not null default 'unknown' check (availability in ('available', 'under_offer', 'sold', 'unknown')),
  arrangement    text,                 -- documented referral / co-broker arrangement, if any
  notes          text,
  created_by     uuid references users(id) on delete set null,
  created_at     timestamptz not null default now()
);
create table if not exists shortlist_items (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references workspaces(id) on delete cascade,     -- the request
  listing_ws     uuid references workspaces(id) on delete restrict,
  external_id    uuid references external_opps(id) on delete restrict,
  rank           integer not null default 0,
  reason         text,
  internal_notes text,
  published      boolean not null default false,
  published_at   timestamptz,
  rechecked_on   date,
  rechecked_price_minor bigint,
  client_feedback text,
  status         text not null default 'proposed' check (status in ('proposed', 'shared', 'selected', 'rejected', 'withdrawn')),
  rejection_reason text,
  created_by     uuid references users(id) on delete set null,
  created_at     timestamptz not null default now(),
  check ((listing_ws is not null) <> (external_id is not null))
);
create unique index if not exists shortlist_once_listing on shortlist_items (workspace_id, listing_ws) where listing_ws is not null;
create unique index if not exists shortlist_once_external on shortlist_items (workspace_id, external_id) where external_id is not null;

-- ---------- viewings ----------
create table if not exists viewings (
  id             uuid primary key default gen_random_uuid(),
  listing_ws     uuid references workspaces(id) on delete restrict,
  external_id    uuid references external_opps(id) on delete restrict,
  request_ws     uuid references workspaces(id) on delete restrict,
  party_id       uuid not null references parties(id) on delete restrict,       -- buyer
  opportunity_id uuid references opportunities(id) on delete set null,
  agent_id       uuid references users(id) on delete set null,
  starts_at      timestamptz not null,
  ends_at        timestamptz not null,
  location       text,
  access         text,
  contact        text,
  status         text not null default 'tentative' check (status in ('tentative', 'confirmed', 'completed', 'cancelled', 'rescheduled', 'no_show')),
  attended       text,
  feedback       text,
  objections     text,
  owner_summary  text,                 -- what the seller may see
  next_followup_on date,
  rescheduled_to uuid references viewings(id) on delete set null,
  created_by     uuid references users(id) on delete set null,
  created_at     timestamptz not null default now(),
  check (ends_at > starts_at),
  check ((listing_ws is not null) or (external_id is not null))
);

-- ---------- offers: every version is kept and never edited ----------
create table if not exists offers (
  id             uuid primary key default gen_random_uuid(),
  ref            text not null unique,
  listing_ws     uuid references workspaces(id) on delete restrict,
  external_id    uuid references external_opps(id) on delete restrict,
  request_ws     uuid references workspaces(id) on delete restrict,
  party_id       uuid not null references parties(id) on delete restrict,       -- buyer
  agent_id       uuid references users(id) on delete set null,
  status         text not null default 'draft' check (status in ('draft', 'submitted', 'countered', 'accepted', 'rejected', 'expired', 'withdrawn')),
  created_by     uuid references users(id) on delete set null,
  created_at     timestamptz not null default now(),
  check ((listing_ws is not null) or (external_id is not null))
);
create table if not exists offer_versions (
  id             uuid primary key default gen_random_uuid(),
  offer_id       uuid not null references offers(id) on delete restrict,
  version        integer not null,
  by_side        text not null check (by_side in ('buyer', 'seller')),
  price_minor    bigint not null check (price_minor > 0),
  currency       text not null default 'BHD',
  payment_terms  text,
  conditions     text,
  proposed_dates text,
  valid_until    date,
  notes          text,
  decision       text check (decision in ('accepted', 'rejected', 'countered', 'expired', 'withdrawn')),
  decided_by_name text,
  decided_on     date,
  decision_evidence text,
  created_by     uuid references users(id) on delete set null,
  created_at     timestamptz not null default now(),
  decision_recorded_by uuid references users(id) on delete set null,
  unique (offer_id, version)
);

-- ---------- deals ----------
create table if not exists deals (
  workspace_id   uuid primary key references workspaces(id) on delete cascade,
  listing_ws     uuid references workspaces(id) on delete restrict,
  external_id    uuid references external_opps(id) on delete restrict,
  request_ws     uuid references workspaces(id) on delete restrict,
  offer_id       uuid unique references offers(id) on delete restrict,
  buyer_id       uuid references parties(id) on delete set null,
  seller_id      uuid references parties(id) on delete set null,
  interest       text not null,                    -- exactly what is being sold (whole property, unit 4, 50% share…)
  accepted_minor bigint not null,
  final_minor    bigint,
  currency       text not null default 'BHD',
  status         text not null default 'in_progress' check (status in ('in_progress', 'completed', 'fell_through')),
  reserved_until date,
  reservation_ref text,
  deposit_holder text,                              -- who holds any purchase deposit (SarayDar does not by default)
  completed_on   date,
  completion_evidence text,
  completed_by   uuid references users(id) on delete set null,
  fell_through_on date,
  fell_through_reason text,
  release_notes  text,
  created_at     timestamptz not null default now()
);
-- one live or completed deal per listing (saleable interest); fallen-through deals stay as history
create unique index if not exists deals_one_per_listing on deals (listing_ws) where listing_ws is not null and status in ('in_progress', 'completed');
create table if not exists deal_checklist (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  title         text not null,
  owner         text,
  due_on        date,
  status        text not null default 'open' check (status in ('open', 'done', 'not_applicable')),
  depends_on    uuid references deal_checklist(id) on delete set null,
  notes         text,
  sort          integer not null default 0,
  done_on       date,
  done_by       uuid references users(id) on delete set null,
  created_at    timestamptz not null default now()
);

-- ---------- commissions on the shared fee ledger ----------
alter table fee_invoices drop constraint if exists fee_invoices_kind_check;
alter table fee_invoices add constraint fee_invoices_kind_check check (kind in ('monthly', 'additional', 'commission'));
alter table fee_invoices add column if not exists deal_ws uuid references workspaces(id) on delete restrict;
alter table fee_invoices add column if not exists mandate_id uuid references sale_mandates(id) on delete restrict;
alter table fee_invoices add column if not exists calc_note text;
-- one commission per deal and side (the seller mandate and the buyer mandate are separate workspaces)
create unique index if not exists fee_invoices_one_commission on fee_invoices (deal_ws, workspace_id) where kind = 'commission' and status <> 'void';

-- ---------- sales expenses ----------
create table if not exists sales_expenses (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete restrict,
  category      text not null,
  description   text not null,
  supplier      text not null,
  invoice_no    text,
  cost_date     date not null,
  amount_minor  bigint not null check (amount_minor > 0),
  payer         text not null check (payer in ('saraydar', 'client_reimbursable', 'client_direct')),
  status        text not null default 'submitted' check (status in ('submitted', 'approved', 'rejected')),
  pay_status    text not null default 'unpaid' check (pay_status in ('unpaid', 'paid')),
  paid_on       date,
  approved_by   uuid references users(id) on delete set null,
  created_by    uuid references users(id) on delete set null,
  created_at    timestamptz not null default now()
);
