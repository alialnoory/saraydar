-- Client projects: who controls the project budget and payments to contractors, suppliers and other third parties.
-- 'saraydar' = SarayDar manages them in the portal; 'client' = the client does, and SarayDar has no part in them.
alter table workspaces add column if not exists budget_control text not null default 'saraydar';
do $$ begin
  alter table workspaces add constraint workspaces_budget_control_chk check (budget_control in ('saraydar', 'client'));
exception when duplicate_object then null; end $$;
