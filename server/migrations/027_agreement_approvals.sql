-- an agreement can be sent to the client for approval from the Fee Billing tab (owner request 2026-10-31)
alter table client_approvals drop constraint if exists client_approvals_subject_check;
alter table client_approvals add constraint client_approvals_subject_check check (subject in ('budget', 'appointment', 'material', 'variation', 'payment', 'design', 'agreement', 'other'));
