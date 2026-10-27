-- AI market search for acquisition requests: the criteria sent, the listings found on public websites, and who ran it.
create table if not exists market_searches (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  brief_version integer,
  criteria     text not null,
  status       text not null default 'running' check (status in ('running', 'done', 'failed')),
  results      jsonb not null default '[]',
  error        text,
  created_by   uuid references users(id) on delete set null,
  created_at   timestamptz not null default now(),
  finished_at  timestamptz
);
create index if not exists market_searches_ws on market_searches (workspace_id, created_at desc);
