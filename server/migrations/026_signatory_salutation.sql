-- "Mr." before the SarayDar signatory in agreements (owner request 2026-10-31)
alter table company_profile add column if not exists signatory_salutation text default 'Mr.';
update company_profile set signatory_salutation = 'Mr.' where signatory_salutation is null;
