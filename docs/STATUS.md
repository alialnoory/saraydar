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
| 4 Client projects | Not started |
| 5 Property management | Not started |
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

## Tests (actual results, 2026-10-23)
- Phase 3 adds 12 tests (money, progress maths, import, setup unknowns/conflicts, plan approval/baseline/revision, task loops and cross-workspace IDs, budget not triple-counted / approval ≠ payment / Finance-only confirmation, photo updates and drafts, PDF/xlsx with formula neutralised). Full suite: 40 pass, 0 fail.
- `cd server && TEST_DATABASE_URL=… npm test` → 28 pass, 0 fail (old API 15, portal 13 groups covering sign-in, MFA, recovery codes, forced password change, workspace isolation, revocation, CSRF/origin, file types, external read-only through direct requests, audit immutability, password reset single use, deactivation, lockout, configurable roles).
- Browser check (Chromium) at 1366 px and 390 px: sign-in → MFA enrolment → dashboard → section → workspace → upload; no horizontal scroll.

## Not yet built (by phase)
- Next: Agreements & contracts tab for all sections (requested 2026-10-23), then Phase 4 Clients Projects Management.
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
