-- Link outbox messages to the record they deliver (for example a rent invoice), and tag attached files.
alter table outbox_messages add column if not exists ref_kind text;
alter table outbox_messages add column if not exists ref_id text;
create index if not exists outbox_ref on outbox_messages (ref_kind, ref_id);
alter table files add column if not exists tag text;
