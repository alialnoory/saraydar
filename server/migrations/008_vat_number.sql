-- SarayDar VAT registration number, printed on tax invoices once VAT is charged.
alter table company_profile add column if not exists vat_number text;
