# SarayDar Management System — Status

Last updated: 2026-10-23

## Live today
- Abuquwa Villas tracker (single project) at https://saraydar.netlify.app, using the `/api` endpoints of the Render service `saraydar-api`.
- Render Postgres `saraydar-db` (free, expires 2026-11-22).

## Phase status
| Phase | State |
|---|---|
| 1 Architecture, data model, screen map, questions | Done (`docs/ARCHITECTURE.md`) |
| Design preview | Approved 2026-10-23 (English only) |
| 2 Foundation | **Done, tested locally, pushed** — see below |
| 3 Development projects | **Done, tested locally, pushed** — see below |
| Agreements & contracts (all sections) | **Done, tested locally, pushed** — see below |
| People, plots, two-step off (2026-10-23 requests) | **Done, tested locally, pushed** — see below |
| 4 Client projects | **Done, tested locally, pushed** — see below (external client view comes with Phase 7 portals) |
| 5 Property management | Next |
| 6 Sales & Acquisition | Not started |
| 7 Portals (invitations), investors, exports, AI, hardening | Not started |

## Phase 2 — what exists (server/)
- Portal served by the same Render service as the old API (`/` portal, `/api/*` old tracker API unchanged).
- Sign-in with username or email; scrypt passwords; server-side sessions in Postgres (httpOnly cookie, 12 h absolute, 2 h idle); CSRF token on every change plus same-host check; rate limits; lock after 10 failures for 15 min.
- Two-step verification (TOTP + 8 single-use recovery codes, seeds encrypted at rest); mandatory for Super Admin.
- Password recovery by single-use 30-minute link (email via outbox); temporary passwords force a change at next sign-in.
- Roles: Super Admin, Project Manager, Finance, Engineer, Viewer, Brokerage Agent, Sales Manager, External viewer; section abilities editable in Administration › Roles.
- Workspaces for all four sections (Abuquwa Villas migrated as DEV-2026-001), references per section and year, portfolio pages with search, status filters, sorting and paging; overview/edit, archive by status.
- Membership-based isolation: non-members get 404 for pages, files and thumbnails; Super Admin sees all. External viewers: My Workspaces, view-only, published files only, every write refused by middleware.
- Documents: multi-file upload (25 MB each), content-type sniffing, thumbnails, caption/location/observation date, internal vs published, protected download.
- Append-only audit log (database trigger refuses edits/deletes); per-workspace activity; Administration: users, roles, outbox, audit log, system.
- Outbox: every email recorded; status "Not configured" until SMTP variables are set; password-reset contents never displayed.

## Phase 3 — what exists
- Guided setup (8 steps + review) with save/resume, "Not yet determined" per question, validation, missing-data and conflict checks; stage answers update the workspace stage.
- Draft plan generator (deterministic, no AI): phases, tasks, milestones by project type/stage/outcome; suggested risks, approvals tracker item, stakeholders, budget lines without invented amounts. Suggested items are labelled; onboarding statuses are marked "reported, unverified".
- Plan approval by the workspace manager: requires phase weights and review confirmation; saves a baseline snapshot (phases, tasks, dates, weights, budget); revisions need a reason; versions kept.
- Tasks & Schedule: phases with weights, tasks with owners, dates, actuals, sub-tasks, milestones, dependencies (loop check), overdue flags, comments; contributors may only update status/progress/actuals.
- Progress: weighted leaf-task method (documented on the Plan tab); unavailable without baseline/weights; planned-vs-actual from baseline dates.
- Budget & Cost (BHD minor units): lines (baseline, current, forecast uncommitted), commitments, supplier invoices (submit → approve/reject, duplicate numbers refused), payments (recorded → confirmed by Finance; reversal with reason; over-payment refused). Committed / incurred / paid / open commitments / EAC kept distinct.
- Progress updates with multiple photos, captions, work area, observation date, draft/publish, feed + gallery filters, comments; photos never change progress; optional explicit "apply % to task".
- Registers: risks, issues, decisions, changes, permits & approvals, stakeholders, procurement, quality, meetings, handover & defects.
- Units & Sales (list price, status); reports: PDF (branded, with photos, period filter) and Excel (separate sheets, formula-injection safe, finance sheets only for finance-visible roles).
- Abuquwa tracker moved into DEV-2026-001 on first start (36 tasks as draft plan v1, 9 budget lines unverified, land commitment, 1 payment awaiting confirmation, 7 risks, 4 units, site log). The old tracker API is read-only (410) and Netlify redirects to the portal.

## Agreements & contracts — what exists
- Agreements tab in every workspace of all four sections; Administration › Agreements for company details, letterhead and templates.
- Letterhead: A4 PNG/JPG placed behind every page of generated PDFs and Word files; header/footer space configurable.
- 12 starter drafts (subcontract, design consultancy, unit sale, project management services, residential lease, commercial lease, property management, maintenance contract, sale mandate, buyer search agreement, reservation form, co-broker). Generic texts, not checked against any jurisdiction; every page they generate carries a legal-review notice. "Make a company copy" to edit wording (versioned, no notice).
- Uploaded Word templates with {{fields}}: questions detected automatically (_amount = money, _date = date), filled Word file produced with the original formatting.
- Preparing an agreement: system fills project/property and company details and the reference; asks for the other party (existing or new; updates the party record) and the template's terms; save with blanks, generate only when required answers are complete; blanks print as lines for hand completion, never invented.
- Every generation is a numbered version (PDF + Word for text templates); issue for signature; record signing date + signed copy (PDF/photo); signed/cancelled agreements are locked; all steps audited.

## Owner requests 2026-10-23 (evening)
- Two-step verification removed: off by default; sign-in is username/email + password. Can be re-enabled with Render variable REQUIRE_MFA=1 (code and tests kept). This departs from spec §3/§12 (Super Admin MFA) by owner decision.
- Profile photos: each person uploads their own (Account); Super Admin can set anyone's (Administration › Users). Square-cropped, shown in header, user list and Access lists.
- Creating logins: Administration › Users and each workspace's Access & Invitations (Super Admin) now take full name, email, username, mobile, job title/company, staff role or external viewer type, workspace role, auto-generated or typed temporary password. Details shown once; optional welcome email (address + username only, never the password); forced password change at first sign-in.
- Land & Plots tab (development projects): any number of plots per project — plot number, title deed, area, frontage × depth, zoning, tenure, registered owner, status, purchase price/date (finance roles), notes, documents per plot; totals; units linked to plots; setup asks number of plots and flags a mismatch; draft plan adds a title/survey check per plot.

## Phase 4 — Clients Projects Management (what exists)
- Client register (`/clients`): individual/company, main contact, authorised representatives, phone, email, address, preferred contact, billing details, tax number, reference, approval authorities, communication responsibilities; linked projects, agreements, correspondence log, fees outstanding, statement across the client's projects. One client can have several projects.
- Client projects use the full project engine (setup, plots, plan/baseline, tasks, registers, progress updates with photos, agreements, documents, reports, exports). The section list shows the client name first, progress, next milestone and unpaid fees.
- Guided onboarding for client projects: project & objectives, site/designs/approvals, current stage, client budget, timeline, contractors/consultants/team, risks. The draft plan uses client-project phases (onboarding, design coordination, approvals, procurement & appointments, construction supervision, handover, defects). The client's approved total is kept as one "unallocated" budget line until split.
- Client & Agreement tab: management-agreement terms as versions (reference, dates, scope, responsibilities, exclusions, monthly fee, billing in advance/arrears, part-month rule, payment days, tax treatment, client approvers). Drafted by the project manager, activated by Finance; old versions kept; a fee change applies from its effective date and cannot rewrite periods already invoiced.
- Fee Billing (SarayDar's own ledger, separate tables from the client's construction spending): monthly draft per month (once per month, calculated day by day from the terms in force, prorated if agreed), authorised extra lines, issue by Finance (INV-YYYY-NNNN, due date from terms), void with reason (only without payments/credits), credit notes (CN-…, never above the outstanding amount), confirmed client payments (duplicate bank reference and repeated form submission refused), allocation across invoices (never above payment or invoice balance), unapplied credit, receipts as a separate step (RCT-…), payment and allocation reversals that keep history, statement with opening/closing balance and period filter, overdue alerts on the home page. PDFs: invoice / tax invoice, receipt, credit note, statement, on the letterhead when uploaded.
- VAT: owner decision 2026-10-23 — no VAT for now. New terms default to "No VAT charged". When VAT starts, record a new terms version from that date with the rate; earlier invoices stay as issued. A VAT invoice cannot be issued until SarayDar's VAT registration number is entered (Admin › Agreements › company details); it then prints on the tax invoice.
- Client Budget & Payments: commitments (contract, order, consultant appointment, approved variation), contractor payment applications / consultant fees / invoices with submitted → reviewed → approved steps (client projects must be reviewed before approval), payments recorded with who paid (client direct, SarayDar on the client's behalf with a client-approval reference, other) and confirmed only by Finance. None of it is counted as SarayDar revenue or cost.
- Client Approvals: requests and externally obtained decisions (budget, appointment, material, variation, payment, design) with approver, date, method, notes, evidence files and linked version; decisions are final (a change needs a new request); "client can see status" flag ready for the Phase 7 portal.
- Fixed with this phase: calendar dates are now read from the database as plain dates, so they no longer shift by a day when the server clock is not UTC.
- Not done in Phase 4: automatic monthly issuing (terms record the flag, nothing issues automatically — needs the paid tier/job scheduler), emailing invoices (needs Outlook SMTP), configurable approval thresholds, the external client view (Phase 7).

## Navigation and exports (owner requests 2026-10-23)
- Every signed-in page has Back (previous page, or the parent page), Home, and Export PDF / Excel where the page has data, on the title row of the dark ribbon, right side (owner request 2026-10-23; previous/next tab buttons removed; the status badge sits next to the location under the project name). Back / Home / PDF / Excel always sit alone at the far right of the title row; page-specific buttons (Create, Clients…) sit on the breadcrumb row. Pages without a ribbon heading show them at the top of the page.
- Every page that shows data has Export PDF and Excel. The export is made from the page exactly as that user sees it (permissions and field hiding carry over), includes all rows (no paging), keeps money/percentages as numbers in Excel, neutralises formula text, and is recorded in the audit log. Forms, buttons and navigation are left out. The richer project report (with photos) remains under Reports.
- Workspace tabs wrap onto extra lines (all visible) and are shown as light-bordered buttons; the current tab is filled.

## Tests (actual results, 2026-10-23)
- Latest full suite: 71 pass, 0 fail (Phase 4 adds 12, incl. VAT-later: proration/fee change/tax maths, client register, onboarding, terms activation by Finance only, once-per-month drafts, issue blocked without tax setting, partial payment/allocation/receipt, duplicate and over-allocation refusal, reversal, credit note limit, statement reconciliation, PDFs, construction spending kept out of fees, review ≠ approval ≠ payment, approvals with evidence, isolation by project and role). Earlier: 59 pass, 0 fail (adds page export/navigation tests) (adds photo, login creation, password generator, plots, MFA-off tests).
- Agreements add 8 tests (field detection/typing, letterhead validation, per-section templates, required terms, generated PDF/Word contents, cross-workspace URL refused, issue/sign/lock, uploaded Word template filled, company copy without notice). Full suite: 48 pass, 0 fail.
- Phase 3 adds 12 tests (money, progress maths, import, setup unknowns/conflicts, plan approval/baseline/revision, task loops and cross-workspace IDs, budget not triple-counted / approval ≠ payment / Finance-only confirmation, photo updates and drafts, PDF/xlsx with formula neutralised). Full suite: 40 pass, 0 fail.
- `cd server && TEST_DATABASE_URL=… npm test` → 28 pass, 0 fail (old API 15, portal 13 groups covering sign-in, MFA, recovery codes, forced password change, workspace isolation, revocation, CSRF/origin, file types, external read-only through direct requests, audit immutability, password reset single use, deactivation, lockout, configurable roles).
- Browser check (Chromium) at 1366 px and 390 px: sign-in → MFA enrolment → dashboard → section → workspace → upload; no horizontal scroll.

## Not yet built (by phase)
- Next: Phase 5 Clients Properties Management (owners, properties, units, leases, automated rent invoicing, maintenance, owner statements, unit history).
- Later: email invitations for external viewers, job scheduler, investors & funding, AI assistant.

## External dependencies (not available yet)
- Outlook SMTP for info@saraydar.com (SMTP_HOST=smtp.office365.com, SMTP_PORT=587, SMTP_USER, SMTP_PASS, MAIL_FROM; Authenticated SMTP must be enabled on the mailbox)
- Paid Render tier before real use (always-on jobs, non-expiring DB)
- DNS CNAME portal.saraydar.com → saraydar-api.onrender.com (+ add the custom domain in Render)
- AI API key (optional)

## Known issues
- Free database expires 2026-11-22.
- Database password was shared in chat on 2026-10-23 — rotate it.
- Files are stored in Postgres; the free 1 GB database limits photo volume. Move to object storage before heavy photo use.
