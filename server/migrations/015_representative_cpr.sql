-- CPR of the person who signs for a client or owner (printed in agreements after "represented by")
alter table parties add column if not exists representative_cpr text;
