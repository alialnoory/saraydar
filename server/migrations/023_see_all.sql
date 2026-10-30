-- Which records a role sees (owner request 2026-10-30): all records of the sections its authority allows, or only
-- those its people are added to. Chairman: sees everything, changes nothing.
alter table roles add column if not exists see_all boolean not null default false;
insert into roles (key, label, kind, permissions, see_all, description) values
  ('chairman', 'Chairman', 'internal', array['view:financials'], true, 'Sees every record in the system, including finance; does not change anything')
on conflict (key) do nothing;
