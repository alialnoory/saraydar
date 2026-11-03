-- The bank a client payment came through, chosen from a list (owner request 2026-11-03), so the reference holds
-- only the transfer or cheque number.
alter table fee_payments add column if not exists bank text;
