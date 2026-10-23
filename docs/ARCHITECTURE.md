# SarayDar Management System — Architecture (Phase 1)

Status: proposal for review, 2026-10-23. Items marked **[Q]** need an answer from the business; items marked **[A]** are reversible technical assumptions used until told otherwise.

## 1. The four business models

| Section (English, exact) | Arabic | Whose money | SarayDar earns | Core object |
|---|---|---|---|---|
| SarayDar Real Estate Development | التطوير العقاري – سراي دار | SarayDar + project investors | Sale proceeds / development return | Development project |
| Clients Projects Management | إدارة مشاريع العملاء | Client (construction budget) | Monthly management fee | Client project + management agreement |
| Clients Properties Management | إدارة عقارات العملاء | Owner (rent, deposits, expenses) | Monthly management fee | Owner → Property → Unit → Lease |
| Property Sales & Acquisition | إدارة بيع وشراء العقارات | Seller / buyer (price, deposits) | Brokerage / advisory fee | Sale mandate, acquisition request, deal |

Consequences carried through the design:
- Every amount belongs to exactly one **ledger** (see §5): development accounts, investor funding, client construction expenditure, owner operations, tenant deposits, SarayDar fees (management), SarayDar fees (brokerage), and separately authorised client money. Dashboards never add across ledgers.
- A client's budget, an owner's rent, a buyer's purchase price and an investor's contribution are **never** SarayDar revenue. SarayDar revenue = issued fee invoices only.
- Sections share platform services (workspaces, records, files, tasks, approvals, invoices, exports, portal) but keep their own entities and rules.

## 2. Architecture and stack

One deployable web application plus one database. Chosen for a small team: one language, one repository, one service.

| Concern | Choice | Why |
|---|---|---|
| Runtime | Node.js 22 LTS, TypeScript 5 | Same language front and back; already in use |
| HTTP | Express 5 | Already used and tested in the current API |
| Database | PostgreSQL 16+ (Render Postgres) | Relational integrity, exclusion constraints for lease overlaps, transactions for posting |
| Migrations | node-pg-migrate (SQL files) | Plain, reviewable SQL |
| Validation | Zod | Same schemas for API and forms |
| Front end | React 18 + Vite, React Router, served by the same service | Same origin → no CORS, httpOnly cookies |
| i18n | i18next; Arabic RTL default, English LTR; IBM Plex Sans Arabic + IBM Plex Sans | Spec 13 |
| Sessions | Server-side sessions in Postgres, httpOnly Secure SameSite=Lax cookie, CSRF token on mutations | Revocable instantly; works on iPhone Safari |
| Passwords | scrypt (Node crypto) | Already implemented |
| MFA | TOTP (RFC 6238) + one-time recovery codes; mandatory for Super Admin | No SMS provider needed |
| Jobs | pg-boss (Postgres-backed queue + cron) | Durable, retries, singleton keys; no extra service |
| Files | Storage adapter: Postgres (start) → S3-compatible (Cloudflare R2) or Render disk later | Works on any tier; swap without data model change |
| Images | sharp: thumbnails, EXIF strip, size limits | Mobile photo uploads |
| PDF | HTML templates rendered by headless Chromium (Playwright) | Only reliable way to get joined Arabic + RTL tables |
| Excel | ExcelJS; formula-injection escaping on every text cell | Spec 5.5 |
| Email | Nodemailer SMTP adapter + built-in **Outbox** (dev mail sink, visible to Super Admin) | Real delivery only when SMTP configured; never marked "sent" otherwise |
| AI | Provider adapter (Anthropic API); disabled when no key | Core works without AI |
| Packaging | Docker image (Playwright base) on Render | Chromium dependencies guaranteed |

Hosting **[Q1]**: Render web service + Render Postgres in Frankfurt. The current free tier sleeps (scheduled invoicing would only run when someone visits) and the free database is deleted on 22 Nov 2026. Production needs: Starter web ($7/mo), Basic Postgres ($6/mo+), and either Postgres-stored files (fine up to a few GB) or R2/disk for photos.

Entry flow: saraydar.com → "Company Portal" button → `https://portal.saraydar.com` (or `projects.saraydar.com`) **[Q4]** → login → main dashboard. The Netlify site becomes a redirect; the current Abuquwa data is migrated into Section 1 as the first development project **[A]**.

## 3. Data isolation and authorisation

- **Workspace** is the unit of isolation: `workspaces(id, section, kind, ref, name, status, client_party_id, …)`. Projects, properties, sale listings, acquisition requests and deals are workspaces. Every business row carries `workspace_id` (NOT NULL, FK, indexed).
- **Membership** grants access: `workspace_members(user_id, workspace_id, role, grants jsonb, invited_by, revoked_at)`. Grants are explicit flags: `view_financials`, `view_tenant_contacts`, `export_pdf`, `export_xlsx`, `download_files`, `view_investor_statement`, etc. Being a contact/investor/tenant never creates membership.
- **Global roles** (Super Admin, Project Manager, Finance, Engineer, Viewer, Brokerage Agent, Sales Manager) define what a user may do; **workspace roles** define where. Super Admin bypasses membership but is still audited.
- **External roles** (Client/Owner/Investor/Seller/Buyer Viewer) are hard-coded read-only: the write middleware rejects every mutation for these principals before any route logic, so a hidden button can't be bypassed through the API. Their own password, language and MFA settings are the only writable items.
- **Publication**: records that external viewers may see have `visibility` (`internal` | `published`) and `published_at/by`. External queries add `visibility = 'published'` in SQL, not in the browser.
- **Field restriction**: every API response passes through an audience serializer (`internal`, `client_viewer`, `owner_viewer`, …) that whitelists fields. Confidential fields (minimum price, margins, other investors, tenant contacts without grant) are never serialised for those audiences. The same serializers feed exports, search, notifications and AI context.
- Workspace ID in a URL is only a lookup key; the server checks membership for that ID every request. Tests try other workspaces' IDs directly.
- Revocation: membership `revoked_at` + session invalidation (sessions table) take effect on the next request.

## 4. Data model (principal entities)

Platform
- `users`, `user_roles`, `sessions`, `mfa_totp`, `recovery_codes`, `password_resets` (single-use, hashed, expiring), `invitations` (single-use, hashed token, expiry, status pending/accepted/expired/revoked)
- `workspaces`, `workspace_members`, `audit_events` (append-only; actor, workspace, action, entity, before/after diff, ip, at)
- `parties` (person/company) with `party_contacts`, `party_roles` (client, owner, investor, seller, buyer, prospect, tenant, supplier, consultant, contractor, co-broker)
- `files`, `file_versions`, `file_links` (to any record), `thumbnails`; `comments`, `notifications`, `notification_prefs`
- `custom_field_defs`, `custom_field_values`; `record_categories`
- `approvals` (request, decision, approver internal/external, evidence file, linked record + version)
- `questionnaire_drafts` (section, step, answers jsonb, each answer with status: verified / unknown / not-yet-determined)
- `outbox_messages`, `delivery_attempts`; `jobs` (pg-boss schema); `export_jobs`
- `number_series` (prefix, year, next_value) — locked row per issue for invoice/receipt numbers

Projects (Sections 1 & 2 share)
- `plans` (draft/approved, baseline version), `phases`, `tasks` (parent, weight, status, progress, dates, owner), `task_dependencies` (cycle check on insert), `milestones`
- `stakeholders`, `contracts`, `variations`, `procurement_items`, `permits`, `risks`, `issues`, `decisions`, `inspections`, `nonconformities`, `meetings`, `site_reports`, `drawings`, `technical_queries`, `submittals`, `defects`, `handover_items`
- `progress_updates` (observation date, linked task/phase, status draft/published, author) + `progress_photos` (file, caption, location, observed_at)
- `budget_lines` (original, revised), `commitments`, `payment_applications`, `cost_invoices`, `cost_payments` (payer, status submitted → reviewed → approved → paid-confirmed are separate events)
- Section 1: `units_for_sale`, `reservations`, `investor_participations`, `contribution_schedule`, `investor_transactions` (contribution/return/distribution; reported vs confirmed; idempotency key)
- Section 2: `management_agreements` (fee, billing day, terms, tax config)

Properties (Section 3)
- `properties`, `property_owners` (share, statement rule), `units` (status), `leases` (EXCLUDE constraint: no overlapping active date ranges per unit), `lease_amendments`, `tenants`
- `rent_charges` (UNIQUE lease_id + period), `deposits`, `deposit_movements`, `service_schedules`, `service_tasks` (UNIQUE schedule + date), `maintenance_requests`, `work_orders`, `quotations`, `shared_cost_allocations`, `owner_transactions` (transfers, contributions, reserves)

Sales & Acquisition (Section 4)
- `sale_mandates`, `listings` (status separate from mandate), `listing_price_history`, `marketing_activities`, `acquisition_requests` + `criteria_revisions`, `external_opportunities`, `matches`, `shortlists` + `shortlist_items`
- `opportunities` (buyer × listing, stage), `activities` (calls, messages, follow-ups), `viewings`, `offers` + `offer_versions` (immutable), `deals` + `deal_checklist_items`, `commission_terms`, `client_money_ledger`
- Partial unique index: one active binding reservation per saleable interest; one completed deal per interest.

Finance (shared)
- `invoices` (ledger, series, number, party, workspace, period, status draft/issued/void, UNIQUE source key e.g. lease+period or agreement+month), `invoice_lines`, `receipts`, `allocations` (CHECK sums via trigger + row locks), `credit_notes`, `reversals`
- Money: BIGINT minor units + `currency` (BHD = 3 decimals). No floats anywhere. Totals only within one currency.

## 5. Financial integrity rules (enforced in code + DB)

1. Posting, allocation, receipt issue, deduction and reversal each run in one transaction with `SELECT … FOR UPDATE` on the invoice/receipt rows.
2. Allocation ≤ min(receipt unallocated, invoice outstanding); over-payment becomes explicit unapplied credit.
3. Issued documents are immutable; corrections are credit notes / voids / reversals that reference the original with a reason.
4. Approval, posting, payment confirmation and receipt issue are separate events with separate actors and timestamps.
5. Idempotency: recurring jobs use deterministic keys (`rent:{lease}:{2026-11}`) protected by UNIQUE constraints, so retries and concurrent workers cannot duplicate.
6. Commitment ≠ invoice ≠ payment: cost reports show committed, incurred (invoiced), and paid as different columns, never summed together.
7. Investor contributions sit in the investor funding ledger, never in revenue or reducing cost.
8. Tax: configurable per agreement/series (rate, label, registration no.), defaulting to "not configured" — no assumed VAT.

## 6. Screen map

```
/login, /mfa, /recover, /invite/:token
/ (Main Portal Dashboard: four section cards + permitted summaries)
/dev            → portfolio → /dev/new (questionnaire) → /dev/:ws
                   tabs: Overview · Plan · Tasks · Schedule · Budget & Cost · Contracts · Progress Updates · Photos
                         Risks & Decisions · Permits · Units & Sales · Investors & Funding · Documents · Access & Invitations · Reports
/cpm            → portfolio (by client) → /cpm/new → /cpm/:ws  (same project tabs + Agreement & Fees, Client Expenditure, Approvals, Statement)
/props          → portfolio (by owner) → /props/new → /props/:ws
                   tabs: Overview · Units · Leases & Tenants · Rent & Invoices · Deposits · Cleaning & Services · Maintenance
                         Owner Account · Management Fees · Unit History & Report · Documents · Access & Invitations · Reports
/sales          → dashboard (Sales Listings | Acquisition Requests | Prospective Buyers | Viewings | Offers & Deals | Fees & Reports)
                   /sales/listings/:ws, /sales/requests/:ws, /sales/deals/:ws, /sales/buyers/:party
/parties/:id (clients, owners, investors, buyers), /finance (invoices, receipts across ledgers, by permission)
/admin (users, roles, approval thresholds, number series, tax, email, storage, outbox, audit log, backups)
/my (external portal: My Workspaces → Projects · Properties · Sales & Acquisitions → read-only workspace views)
```

## 7. Phases (each ends with working UI + API, automated tests, a STATUS update and a push)

1. This document + design preview for approval.
2. Foundation: new app skeleton, migrations, auth (sessions, CSRF, TOTP MFA, recovery, rate limit, deactivation), bilingual RTL/LTR shell, workspaces/memberships/permissions middleware, files + thumbnails, audit, jobs, outbox, Super Admin console, migration of current Abuquwa data.
3. Development projects: questionnaire → draft plan → approval/baseline → tasks/dependencies/weighted progress → budget/commitments/cost → progress updates + photos → exports.
4. Client projects: clients, agreements, client expenditure ledger, approvals recorded with evidence, monthly fee invoices, receipts/allocations/credit notes, statements.
5. Property management: owners/properties/units, leases with overlap constraint, opening balances review, rent charges + automated monthly invoicing with idempotent jobs, deposits, maintenance with approvals/photos, cleaning schedules, owner accounts/statements, fees, Unit History & Report.
6. Sales & Acquisition: mandates, listings/price history, marketing, buyer CRM + follow-ups, acquisition requests, matching/shortlists, viewings, offers/versions, deals/checklists, commissions.
7. External view-only portals (all five viewer roles), investors & funding, cross-section reports, PDF/Excel everywhere, AI assistant path, backup/restore drill, acceptance tests A–I.

Testing: `node --test` + Supertest against a real Postgres (embedded in CI), Playwright end-to-end at phone width in Arabic and English, explicit negative tests (other workspace IDs, external viewer writes, duplicate job runs, concurrent allocations).

## 8. Questions and assumptions

- **[Q1] Hosting tier** — ANSWERED: free tier while building; upgrade before real staff/client use.
- **[Q2] Brand assets** — ANSWERED: use the current copper/espresso SARAYDAR theme as the approved identity. Original note: official logo files (SVG/PNG, Arabic + English variants) and brand colours. The name in the spec is "SarayDar / سراي دار"; the current site uses the "SARAYDAR" wordmark and copper/espresso palette derived from the image you sent earlier — treated as **temporary** until confirmed.
- **[Q3] Email provider** — ANSWERED: send from info@saraydar.com; SMTP host/credentials still needed (who hosts that mailbox?). Original note: needed for invitations, password recovery and invoice delivery (any SMTP: Google Workspace, Microsoft 365, Resend…). Until then everything goes to the in-app Outbox and shows "not configured".
- **[Q4] Portal address** — ANSWERED: portal.saraydar.com (needs a CNAME where saraydar.com DNS is managed). Original note: e.g. `portal.saraydar.com`; and where saraydar.com is hosted, for the Company Portal button.
- [A] Login uses username **or** email + password.
- [A] Timezone Asia/Bahrain; currency default BHD (3 decimals); other currencies allowed but never mixed in totals.
- [A] Tax is "not configured" until Finance sets it.
- [A] Payment gateway: not in this release; the payment layer has a provider interface for later.
- [A] AI: off until an API key is configured.
- [A] Demonstration data lives only in a separate `demo` seed, labelled "DEMO" on every screen, never loaded in production.

## 9. Honest scope note

The specification is a full ERP-scale product. It will be delivered over several working sessions, phase by phase, with `docs/STATUS.md` recording what is implemented, tested, externally dependent and still missing. Nothing is reported as done without a passing test or a visible result.
