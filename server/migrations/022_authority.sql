-- Authority matrix (owner request 2026-10-29): what each staff role may do in each area of the system, and money limits.
-- matrix: {"<area>": ["view","create","edit","approve","delete","export"], ...}; null = the built-in default for the role
-- limits: {"<kind>": <max in fils> | null (no limit) }; a missing kind = not allowed
alter table roles add column if not exists matrix jsonb;
alter table roles add column if not exists limits jsonb;
alter table roles add column if not exists description text;
insert into roles (key, label, kind, permissions) values
  ('site_supervisor', 'Site Supervisor', 'internal', array[]::text[]),
  ('administrator',   'Administrator',   'internal', array[]::text[])
on conflict (key) do nothing;
