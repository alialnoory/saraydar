-- the client or owner signs agreements personally (no representative)
alter table parties add column if not exists signs_personally boolean not null default false;
