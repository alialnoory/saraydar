-- Construction master plan (owner request 2026-10-27): one shared default template for SarayDar Real Estate
-- Development and Clients Projects Management, copied into each project as its own editable plan.

-- the default template (edited by the Super Admin; changes apply to future projects only)
create table if not exists master_templates (
  key        text primary key,
  version    integer not null default 1,
  stages     jsonb not null,
  updated_by uuid references users(id) on delete set null,
  updated_at timestamptz not null default now()
);

-- which projects run on the master plan, and from which template version
create table if not exists master_plans (
  workspace_id     uuid primary key references workspaces(id) on delete cascade,
  template_key     text not null,
  template_version integer not null,
  anchor_start     date,                 -- start date used for the illustrative schedule, if any
  defects_months   integer,              -- contractual defects period used for the last stage
  applied_by       uuid references users(id) on delete set null,
  applied_at       timestamptz not null default now()
);

-- the previous plan of a project, kept read-only and restorable when the master plan replaces it
create table if not exists plan_archives (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  reason       text not null,
  snapshot     jsonb not null,          -- phases, tasks, dependencies and mapping at the moment of replacement
  phase_ids    uuid[] not null default '{}',
  task_ids     uuid[] not null default '{}',
  created_by   uuid references users(id) on delete set null,
  created_at   timestamptz not null default now(),
  restored_at  timestamptz,
  restored_by  uuid references users(id) on delete set null
);
create index if not exists plan_archives_ws on plan_archives (workspace_id, created_at desc);

-- stages: details people can edit
alter table phases add column if not exists template_key   text;
alter table phases add column if not exists description    text;
alter table phases add column if not exists owner_text     text;
alter table phases add column if not exists hold           boolean not null default false;   -- On hold, set by people; otherwise status comes from the tasks
alter table phases add column if not exists progress       integer check (progress is null or progress between 0 and 100);   -- only used when a stage has no tasks
alter table phases add column if not exists planned_start  date;
alter table phases add column if not exists planned_end    date;
alter table phases add column if not exists actual_start   date;
alter table phases add column if not exists actual_finish  date;
alter table phases add column if not exists notes          text;
alter table phases add column if not exists duration_note  text;     -- "indicative 4–8 weeks": a default, not a promise
alter table phases add column if not exists start_week     numeric(6,2);
alter table phases add column if not exists end_week       numeric(6,2);
alter table phases add column if not exists after_handover boolean not null default false;

-- tasks: stable template link, description and the On hold status
alter table tasks add column if not exists template_key text;
alter table tasks add column if not exists description  text;
alter table tasks drop constraint if exists tasks_status_check;
alter table tasks add constraint tasks_status_check check (status in ('not_started', 'in_progress', 'on_hold', 'blocked', 'done', 'cancelled'));

-- procurement tracker for key materials (dates in calendar days; nothing is invented)
create table if not exists procurement_items (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  phase_id      uuid references phases(id) on delete set null,
  item          text not null,
  responsible   text,
  approval_days integer check (approval_days is null or approval_days >= 0),
  lead_days     integer check (lead_days is null or lead_days >= 0),
  buffer_days   integer check (buffer_days is null or buffer_days >= 0),
  needed_on     date,
  status        text not null default 'planned' check (status in ('planned', 'approved', 'ordered', 'delivered', 'cancelled')),
  notes         text,
  sort          integer not null default 0,
  created_by    uuid references users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  archived_at   timestamptz
);
create index if not exists procurement_items_ws on procurement_items (workspace_id);
