-- How an individual is addressed in agreements: Mr., Mrs., Ms., Dr., Eng. (owner request 2026-10-31)
alter table parties add column if not exists salutation text;
