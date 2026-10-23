-- Phase 7: view-only external portal (invitations, visibility grants) and project investors.

-- ---------- invitations: single use, expiring, never delivered silently ----------
create table if not exists invitations (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  email         text not null,
  name          text not null,
  party_id      uuid references parties(id) on delete set null,
  role          text not null check (role in ('client_viewer', 'owner_viewer', 'investor_viewer', 'seller_viewer', 'buyer_viewer')),
  grants        jsonb not null default '{}'::jsonb,
  token_hash    text not null unique,
  status        text not null default 'pending' check (status in ('pending', 'accepted', 'revoked', 'superseded')),
  expires_at    timestamptz not null,
  recipient_checked text not null,                 -- how staff verified the intended recipient
  outbox_id     bigint,
  created_by    uuid references users(id) on delete set null,
  created_at    timestamptz not null default now(),
  accepted_at   timestamptz,
  accepted_user uuid references users(id) on delete set null,
  revoked_at    timestamptz,
  revoked_by    uuid references users(id) on delete set null
);
create index if not exists invitations_ws on invitations (workspace_id, created_at desc);
alter table users add column if not exists party_id uuid references parties(id) on delete set null;

-- maintenance shown to the owner only when staff publish it
alter table maint_requests add column if not exists owner_visible boolean not null default false;

-- ---------- project investors ----------
create table if not exists investor_participations (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references workspaces(id) on delete restrict,     -- the development project
  party_id        uuid not null references parties(id) on delete restrict,
  ref             text not null unique,
  agreement_ref   text,
  agreement_id    uuid references agreements(id) on delete set null,
  participation   text not null default 'unconfirmed' check (participation in ('equity', 'loan', 'profit_share', 'other', 'unconfirmed')),
  currency        text not null default 'BHD',
  committed_minor bigint check (committed_minor >= 0),
  start_date      date,
  end_date        date,
  ownership_terms text,             -- only as documented; nothing derived from contributions
  profit_terms    text,
  return_terms    text,
  terms_confirmed boolean not null default false,
  status          text not null default 'active' check (status in ('active', 'completed', 'withdrawn')),
  notes           text,
  created_by      uuid references users(id) on delete set null,
  created_at      timestamptz not null default now()
);
create table if not exists investor_installments (
  id               uuid primary key default gen_random_uuid(),
  participation_id uuid not null references investor_participations(id) on delete cascade,
  due_on           date not null,
  amount_minor     bigint not null check (amount_minor > 0),
  note             text
);
create table if not exists investor_txns (
  id               uuid primary key default gen_random_uuid(),
  participation_id uuid not null references investor_participations(id) on delete restrict,
  workspace_id     uuid not null references workspaces(id) on delete restrict,
  kind             text not null check (kind in ('contribution', 'capital_return', 'distribution', 'adjustment')),
  status           text not null default 'reported' check (status in ('reported', 'confirmed', 'rejected', 'reversed')),
  on_date          date not null,
  amount_minor     bigint not null,                                   -- adjustments may be negative
  currency         text not null default 'BHD',
  method           text,
  reference        text,
  evidence         text,
  approval_ref     text,                                              -- required for returns and distributions
  idem_key         text unique,
  ack_no           text unique,                                       -- contribution acknowledgment, after confirmation
  recorded_by      uuid references users(id) on delete set null,
  recorded_at      timestamptz not null default now(),
  confirmed_by     uuid references users(id) on delete set null,
  confirmed_at     timestamptz,
  reverse_reason   text,
  check (kind = 'adjustment' or amount_minor > 0)
);
create unique index if not exists investor_txns_no_dup on investor_txns (participation_id, kind, lower(reference)) where reference is not null and status in ('reported', 'confirmed');
