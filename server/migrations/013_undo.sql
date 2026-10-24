-- Undo / redo of a person's own recent edits (owner request 2026-10-24). Each entry holds the before/after values
-- of the rows one save changed. Undo applies only if the rows still hold the "after" values (nobody changed them
-- since); redo only if they still hold the "before" values. Money records are not covered: they use reversals.
create table if not exists undo_log (
  id           bigint generated always as identity primary key,
  user_id      uuid not null references users(id) on delete cascade,
  workspace_id uuid references workspaces(id) on delete cascade,
  label        text not null,
  changes      jsonb not null,          -- [{table, key, id, before, after}]
  return_to    text,
  created_at   timestamptz not null default now(),
  undone_at    timestamptz,
  dead         boolean not null default false      -- a newer edit replaced the redo chain
);
create index if not exists undo_log_user on undo_log (user_id, id desc);
