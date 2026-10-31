-- The client's title in the project, printed as the defined term in agreements: Project Owner, Project Developer,
-- Project Partner … (owner request 2026-10-31)
alter table parties add column if not exists capacity text;
