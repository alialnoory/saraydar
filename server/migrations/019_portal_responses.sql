-- Clients answer approval requests in the portal (owner request 2026-10-25).
alter table client_approvals add column if not exists client_note text;          -- what the client is asked, shown in the portal
alter table client_approvals add column if not exists client_comment text;       -- the client's own comment with the decision
alter table client_approvals add column if not exists responded_by uuid references users(id) on delete set null;   -- external user who answered in the portal
alter table client_approvals add column if not exists responded_at timestamptz;
