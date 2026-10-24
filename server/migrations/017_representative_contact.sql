-- telephone and email of the person who represents a client or owner
alter table parties add column if not exists representative_phone text;
alter table parties add column if not exists representative_email text;
