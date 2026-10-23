-- The existing Abuquwa Villas tracker becomes the first SarayDar Real Estate Development workspace.
-- Its tasks, budget and log stay in the original "records" table until Phase 3 moves them.
insert into workspaces (section, kind, ref, name, status, location, legacy)
values ('dev', 'project', 'DEV-2026-001', 'Abuquwa Villas', 'active', 'Abuquwa, Bahrain', true)
on conflict (ref) do nothing;

insert into number_series (key, next_value) values ('DEV-2026', 2)
on conflict (key) do nothing;
