-- Management terms carry the termination notice so the agreement can be generated entirely from them.
alter table mgmt_terms add column if not exists notice_days integer check (notice_days is null or notice_days between 0 and 365);
