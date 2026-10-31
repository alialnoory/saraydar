-- Signing agreements on screen (owner request 2026-10-31): SarayDar's signature and stamp printed by a Super Admin,
-- the client's signature drawn on screen; the agreement text is kept with each version so it can be signed later.
alter table company_profile add column if not exists signature_img bytea;
alter table company_profile add column if not exists stamp_img bytea;
alter table agreement_versions add column if not exists text text;
alter table agreement_versions add column if not exists sd_signed_by uuid references users(id) on delete set null;
alter table agreement_versions add column if not exists sd_signed_at timestamptz;
alter table agreement_versions add column if not exists client_sig bytea;
alter table agreement_versions add column if not exists client_signed_name text;
alter table agreement_versions add column if not exists client_signed_at timestamptz;
alter table agreement_versions add column if not exists client_signed_ip text;
alter table agreement_versions add column if not exists client_signed_by uuid references users(id) on delete set null;
alter table agreement_versions add column if not exists client_signed_via text;
