-- Saraydar project control: Supabase setup
-- Run once in Supabase → SQL Editor → New query → paste → Run.
-- Safe to run again: it skips what already exists and never overwrites records.

-- 1. Tables ------------------------------------------------------------------

create table if not exists public.profiles (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  email      text,
  full_name  text not null default '',
  role       text not null default 'viewer' check (role in ('admin', 'editor', 'site', 'viewer')),
  created_at timestamptz not null default now()
);

create table if not exists public.records (
  collection text not null check (collection in ('tasks', 'costs', 'payments', 'units', 'risks', 'log', 'meta')),
  id         text not null,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null,
  primary key (collection, id)
);

-- Every change is kept here: who changed what, when, before and after.
create table if not exists public.record_history (
  history_id bigint generated always as identity primary key,
  collection text not null,
  id         text not null,
  action     text not null,
  old_data   jsonb,
  new_data   jsonb,
  changed_by uuid,
  changed_at timestamptz not null default now()
);

-- 2. Role of the signed-in user ---------------------------------------------

create or replace function public.app_role() returns text
language sql stable security definer set search_path = public as $$
  select role from public.profiles where user_id = auth.uid()
$$;

-- 3. New login → profile. The very first user becomes Admin; later users start as Viewer.

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (user_id, email, full_name, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    case when exists (select 1 from public.profiles) then 'viewer' else 'admin' end
  )
  on conflict (user_id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Profiles for any users created before this script ran
insert into public.profiles (user_id, email)
select id, email from auth.users
on conflict (user_id) do nothing;
update public.profiles set role = 'admin'
where user_id = (select user_id from public.profiles order by created_at limit 1)
  and not exists (select 1 from public.profiles where role = 'admin');

-- 4. Stamp and audit every record change -------------------------------------

create or replace function public.records_stamp() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end $$;

drop trigger if exists records_stamp on public.records;
create trigger records_stamp
  before insert or update on public.records
  for each row execute function public.records_stamp();

create or replace function public.records_audit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    insert into public.record_history (collection, id, action, old_data, changed_by)
    values (old.collection, old.id, tg_op, old.data, auth.uid());
  elsif tg_op = 'UPDATE' then
    insert into public.record_history (collection, id, action, old_data, new_data, changed_by)
    values (new.collection, new.id, tg_op, old.data, new.data, auth.uid());
  else
    insert into public.record_history (collection, id, action, new_data, changed_by)
    values (new.collection, new.id, tg_op, new.data, auth.uid());
  end if;
  return null;
end $$;

drop trigger if exists records_audit on public.records;
create trigger records_audit
  after insert or update or delete on public.records
  for each row execute function public.records_audit();

-- 5. Access rules (enforced by the database, not just the page) ---------------
--   admin  : everything, and manages users' roles
--   editor : add, edit, delete all project records
--   site   : add and edit site log entries, update task progress
--   viewer : read only

alter table public.profiles       enable row level security;
alter table public.records        enable row level security;
alter table public.record_history enable row level security;

drop policy if exists "profiles: read own or admin" on public.profiles;
create policy "profiles: read own or admin" on public.profiles
  for select to authenticated
  using (user_id = auth.uid() or public.app_role() = 'admin');

drop policy if exists "profiles: admin updates" on public.profiles;
create policy "profiles: admin updates" on public.profiles
  for update to authenticated
  using (public.app_role() = 'admin')
  with check (public.app_role() = 'admin');

drop policy if exists "records: members read" on public.records;
create policy "records: members read" on public.records
  for select to authenticated
  using (public.app_role() is not null);

drop policy if exists "records: insert" on public.records;
create policy "records: insert" on public.records
  for insert to authenticated
  with check (public.app_role() in ('admin', 'editor')
              or (public.app_role() = 'site' and collection = 'log'));

drop policy if exists "records: update" on public.records;
create policy "records: update" on public.records
  for update to authenticated
  using (public.app_role() in ('admin', 'editor')
         or (public.app_role() = 'site' and collection in ('log', 'tasks')))
  with check (public.app_role() in ('admin', 'editor')
              or (public.app_role() = 'site' and collection in ('log', 'tasks')));

drop policy if exists "records: delete" on public.records;
create policy "records: delete" on public.records
  for delete to authenticated
  using (public.app_role() in ('admin', 'editor'));

drop policy if exists "history: admin and editors read" on public.record_history;
create policy "history: admin and editors read" on public.record_history
  for select to authenticated
  using (public.app_role() in ('admin', 'editor'));

-- 6. Live updates: open pages refresh when someone saves ----------------------

do $$
begin
  alter publication supabase_realtime add table public.records;
exception when duplicate_object then null;
end $$;

-- 7. Current project data (exported 22 Oct 2026) ------------------------------

insert into public.records (collection, id, data) values
  ('costs', 'build', $seed${"budget": 180000, "category": "Construction", "committed": 0, "item": "Construction: 1,000 m² at BD 180/m²", "order": 2}$seed$::jsonb),
  ('costs', 'contingency', $seed${"budget": 8820, "category": "Contingency", "committed": 0, "item": "Contingency (2%)", "notes": "Recommended: raise to 5% of construction", "order": 6}$seed$::jsonb),
  ('costs', 'design', $seed${"budget": 5000, "category": "Professional fees", "committed": 0, "item": "Design and supervision", "notes": "BD 1,250 per unit", "order": 3}$seed$::jsonb),
  ('costs', 'finance', $seed${"budget": 0, "category": "Finance", "committed": 0, "item": "Financing costs", "order": 8}$seed$::jsonb),
  ('costs', 'land', $seed${"budget": 250000, "category": "Land", "committed": 250000, "item": "Land: 4 plots", "order": 1}$seed$::jsonb),
  ('costs', 'permits', $seed${"budget": 2000, "category": "Government & utilities", "committed": 0, "item": "Permits and government fees", "notes": "BD 500 per unit", "order": 4}$seed$::jsonb),
  ('costs', 'registration', $seed${"budget": 0, "category": "Government & utilities", "committed": 0, "item": "Registration, subdivision and escrow fees", "order": 9}$seed$::jsonb),
  ('costs', 'sales', $seed${"budget": 0, "category": "Sales & marketing", "committed": 0, "item": "Sales commission and marketing", "order": 7}$seed$::jsonb),
  ('costs', 'utilities', $seed${"budget": 4000, "category": "Government & utilities", "committed": 0, "item": "Utility connections (EWA)", "notes": "BD 1,000 per unit", "order": 5}$seed$::jsonb),
  ('log', 'l1', $seed${"author": "Ali", "date": "2026-10-22", "issues": "", "progress": 0, "work": "Land purchase for the 4 plots completed. Execution plan drafted for steering committee review.", "workforce": 0}$seed$::jsonb),
  ('meta', 'project', $seed${"company": "Saraydar Real Estate", "handover": "2028-04-23", "name": "Abuquwa Villas", "start": "2026-11-01"}$seed$::jsonb),
  ('payments', 'p-land', $seed${"amount": 250000, "costId": "land", "date": "", "notes": "Purchase completed. Add the actual payment date.", "payee": "Land sellers", "reference": ""}$seed$::jsonb),
  ('risks', 'r1', $seed${"impact": "High", "likelihood": "Medium", "mitigation": "Lump-sum contract, contingency raised to 5%, design freeze", "owner": "Project Manager", "risk": "Construction cost overrun", "status": "Open"}$seed$::jsonb),
  ('risks', 'r2', $seed${"impact": "High", "likelihood": "Medium", "mitigation": "Test price with brokers before design freeze, pre-registration, flexible pricing", "owner": "Sales", "risk": "Slow sales or lower selling price", "status": "Open"}$seed$::jsonb),
  ('risks', 'r3', $seed${"impact": "Medium", "likelihood": "Medium", "mitigation": "Early Benayat submission, weekly follow-up on EWA application", "owner": "Consultant", "risk": "Delay in permits or utility connections", "status": "Open"}$seed$::jsonb),
  ('risks', 'r4', $seed${"impact": "High", "likelihood": "Low", "mitigation": "Prequalification, 10% performance bond, payments against certified progress", "owner": "Project Manager", "risk": "Contractor default", "status": "Open"}$seed$::jsonb),
  ('risks', 'r5', $seed${"impact": "Medium", "likelihood": "Medium", "mitigation": "Fixed price in contract, early steel purchase if needed", "owner": "Contractor", "risk": "Material price increases", "status": "Open"}$seed$::jsonb),
  ('risks', 'r6', $seed${"impact": "Medium", "likelihood": "Low", "mitigation": "Check setbacks and build ratios before detailed design", "owner": "Consultant", "risk": "Layout does not fit plot or planning rules", "status": "Open"}$seed$::jsonb),
  ('risks', 'r7', $seed${"impact": "High", "likelihood": "Low", "mitigation": "Mandatory safety plan and weekly inspection", "owner": "Contractor", "risk": "Safety incident on site", "status": "Open"}$seed$::jsonb),
  ('tasks', 't01', $seed${"due": "2026-11-05", "owner": "Managing Director", "phase": "1 · Mobilisation", "progress": 0, "start": "2026-11-01", "status": "Not started", "title": "Appoint project manager and issue authority letter"}$seed$::jsonb),
  ('tasks', 't02', $seed${"due": "2026-11-12", "owner": "Project Manager", "phase": "1 · Mobilisation", "progress": 0, "start": "2026-11-01", "status": "Not started", "title": "Request proposals from 3 consulting offices"}$seed$::jsonb),
  ('tasks', 't03', $seed${"due": "2026-11-19", "owner": "Project Manager", "phase": "1 · Mobilisation", "progress": 0, "start": "2026-11-12", "status": "Not started", "title": "Appoint design and supervision consultant"}$seed$::jsonb),
  ('tasks', 't04', $seed${"due": "2026-11-15", "notes": "Survey & Land Registration Bureau; setbacks and build ratios", "owner": "Legal", "phase": "1 · Mobilisation", "progress": 0, "start": "2026-11-01", "status": "Not started", "title": "Confirm title deeds and planning regulations for the 4 plots"}$seed$::jsonb),
  ('tasks', 't05', $seed${"due": "2026-11-28", "owner": "Consultant", "phase": "1 · Mobilisation", "progress": 0, "start": "2026-11-15", "status": "Not started", "title": "Topographic survey and soil investigation"}$seed$::jsonb),
  ('tasks', 't06', $seed${"due": "2026-11-26", "owner": "Steering Committee", "phase": "1 · Mobilisation", "progress": 0, "start": "2026-11-01", "status": "Not started", "title": "Decide financing route: equity, bank or off-plan"}$seed$::jsonb),
  ('tasks', 't07', $seed${"due": "2026-11-19", "owner": "Finance", "phase": "1 · Mobilisation", "progress": 0, "start": "2026-11-05", "status": "Not started", "title": "Open dedicated project bank account"}$seed$::jsonb),
  ('tasks', 't08', $seed${"due": "2026-11-20", "owner": "Finance", "phase": "1 · Mobilisation", "progress": 0, "start": "2026-11-05", "status": "Not started", "title": "Update budget: add missing items, raise contingency to 5%"}$seed$::jsonb),
  ('tasks', 't09', $seed${"due": "2026-11-26", "owner": "Managing Director", "phase": "1 · Mobilisation", "progress": 0, "start": "2026-11-26", "status": "Not started", "title": "Steering committee #1: approve baseline budget and schedule"}$seed$::jsonb),
  ('tasks', 't10', $seed${"due": "2026-12-17", "owner": "Consultant", "phase": "2 · Design", "progress": 0, "start": "2026-11-20", "status": "Not started", "title": "Concept design: adapt Villa 400 A to 10.3 × 17 m plots"}$seed$::jsonb),
  ('tasks', 't11', $seed${"due": "2026-12-24", "owner": "Sales", "phase": "2 · Design", "progress": 0, "start": "2026-12-10", "status": "Not started", "title": "Broker review of layout and pricing (2–3 brokers)"}$seed$::jsonb),
  ('tasks', 't12', $seed${"due": "2027-01-28", "owner": "Consultant", "phase": "2 · Design", "progress": 0, "start": "2026-12-20", "status": "Not started", "title": "Detailed design: architectural, structural, MEP"}$seed$::jsonb),
  ('tasks', 't13', $seed${"due": "2027-01-31", "owner": "Consultant", "phase": "2 · Design", "progress": 0, "start": "2027-01-10", "status": "Not started", "title": "Specifications and bill of quantities"}$seed$::jsonb),
  ('tasks', 't14', $seed${"due": "2027-01-31", "notes": "No changes after this without a change order", "owner": "Steering Committee", "phase": "2 · Design", "progress": 0, "start": "2027-01-31", "status": "Not started", "title": "Design freeze"}$seed$::jsonb),
  ('tasks', 't15', $seed${"due": "2027-02-21", "owner": "Consultant", "phase": "3 · Permits", "progress": 0, "start": "2027-02-01", "status": "Not started", "title": "Building permit submission via Benayat"}$seed$::jsonb),
  ('tasks', 't16', $seed${"due": "2027-03-07", "owner": "Consultant", "phase": "3 · Permits", "progress": 0, "start": "2027-02-01", "status": "Not started", "title": "Civil Defence approval"}$seed$::jsonb),
  ('tasks', 't17', $seed${"due": "2027-03-07", "owner": "Consultant", "phase": "3 · Permits", "progress": 0, "start": "2027-02-01", "status": "Not started", "title": "EWA and sewerage approvals"}$seed$::jsonb),
  ('tasks', 't18', $seed${"due": "2027-02-07", "owner": "Project Manager", "phase": "4 · Tender & Contract", "progress": 0, "start": "2027-01-24", "status": "Not started", "title": "Prequalify 4–5 contractors"}$seed$::jsonb),
  ('tasks', 't19', $seed${"due": "2027-02-28", "owner": "Consultant", "phase": "4 · Tender & Contract", "progress": 0, "start": "2027-02-07", "status": "Not started", "title": "Issue tender to at least 3 contractors"}$seed$::jsonb),
  ('tasks', 't20', $seed${"due": "2027-03-07", "owner": "Project Manager", "phase": "4 · Tender & Contract", "progress": 0, "start": "2027-02-28", "status": "Not started", "title": "Technical and financial evaluation of bids"}$seed$::jsonb),
  ('tasks', 't21', $seed${"due": "2027-03-12", "owner": "Managing Director", "phase": "4 · Tender & Contract", "progress": 0, "start": "2027-03-07", "status": "Not started", "title": "Award and sign lump-sum contract (bonds + CAR insurance)"}$seed$::jsonb),
  ('tasks', 't22', $seed${"due": "2027-03-28", "owner": "Contractor", "phase": "5 · Construction", "progress": 0, "start": "2027-03-14", "status": "Not started", "title": "Site mobilisation and hoarding"}$seed$::jsonb),
  ('tasks', 't23', $seed${"due": "2027-05-15", "owner": "Contractor", "phase": "5 · Construction", "progress": 0, "start": "2027-03-28", "status": "Not started", "title": "Foundations"}$seed$::jsonb),
  ('tasks', 't24', $seed${"due": "2027-08-01", "notes": "Frame completion triggers sales launch", "owner": "Contractor", "phase": "5 · Construction", "progress": 0, "start": "2027-05-15", "status": "Not started", "title": "Structural frame: ground, first floor, roof"}$seed$::jsonb),
  ('tasks', 't25', $seed${"due": "2027-10-31", "owner": "Contractor", "phase": "5 · Construction", "progress": 0, "start": "2027-08-01", "status": "Not started", "title": "Blockwork and MEP rough-in"}$seed$::jsonb),
  ('tasks', 't26', $seed${"due": "2028-02-27", "owner": "Contractor", "phase": "5 · Construction", "progress": 0, "start": "2027-11-01", "status": "Not started", "title": "Finishes, façades and external works"}$seed$::jsonb),
  ('tasks', 't27', $seed${"due": "2028-03-20", "owner": "Consultant", "phase": "6 · Handover & Close-out", "progress": 0, "start": "2028-02-28", "status": "Not started", "title": "EWA connection and testing"}$seed$::jsonb),
  ('tasks', 't28', $seed${"due": "2028-03-31", "owner": "Consultant", "phase": "6 · Handover & Close-out", "progress": 0, "start": "2028-03-01", "status": "Not started", "title": "Snagging and initial acceptance"}$seed$::jsonb),
  ('tasks', 't29', $seed${"due": "2028-04-10", "owner": "Consultant", "phase": "6 · Handover & Close-out", "progress": 0, "start": "2028-03-20", "status": "Not started", "title": "Building completion certificate"}$seed$::jsonb),
  ('tasks', 't30', $seed${"due": "2028-04-23", "owner": "Project Manager", "phase": "6 · Handover & Close-out", "progress": 0, "start": "2028-04-01", "status": "Not started", "title": "Unit registration and key handover to buyers"}$seed$::jsonb),
  ('tasks', 't31', $seed${"due": "2029-04-23", "owner": "Project Manager", "phase": "7 · Defects Liability", "progress": 0, "start": "2028-04-23", "status": "Not started", "title": "Defects liability period and retention release"}$seed$::jsonb),
  ('tasks', 't32', $seed${"due": "2026-12-31", "owner": "Steering Committee", "phase": "Sales & Marketing", "progress": 0, "start": "2026-11-26", "status": "Not started", "title": "Decide: sell off-plan (RERA licence + escrow) or on completion"}$seed$::jsonb),
  ('tasks', 't33', $seed${"due": "2027-02-28", "owner": "Naqsh Media", "phase": "Sales & Marketing", "progress": 0, "start": "2027-01-15", "status": "Not started", "title": "Project brand, brochure and 3D visuals"}$seed$::jsonb),
  ('tasks', 't34', $seed${"due": "2027-07-31", "owner": "Sales", "phase": "Sales & Marketing", "progress": 0, "start": "2027-02-01", "status": "Not started", "title": "Pre-registration campaign"}$seed$::jsonb),
  ('tasks', 't35', $seed${"due": "2027-09-30", "owner": "Sales", "phase": "Sales & Marketing", "progress": 0, "start": "2027-08-01", "status": "Not started", "title": "Sales launch at frame completion"}$seed$::jsonb),
  ('tasks', 't36', $seed${"due": "2028-01-31", "owner": "Sales", "phase": "Sales & Marketing", "progress": 0, "start": "2027-12-01", "status": "Not started", "title": "Fit out and furnish show villa"}$seed$::jsonb),
  ('units', 'v1', $seed${"collected": 0, "price": 135000, "status": "Available", "unit": "Villa 1"}$seed$::jsonb),
  ('units', 'v2', $seed${"collected": 0, "price": 135000, "status": "Available", "unit": "Villa 2"}$seed$::jsonb),
  ('units', 'v3', $seed${"collected": 0, "price": 135000, "status": "Available", "unit": "Villa 3"}$seed$::jsonb),
  ('units', 'v4', $seed${"collected": 0, "price": 135000, "status": "Available", "unit": "Villa 4"}$seed$::jsonb)
on conflict (collection, id) do nothing;
