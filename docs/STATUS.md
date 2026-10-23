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
| 3 Development projects | Next |
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

## Tests (actual results, 2026-10-23)
- `cd server && TEST_DATABASE_URL=… npm test` → 28 pass, 0 fail (old API 15, portal 13 groups covering sign-in, MFA, recovery codes, forced password change, workspace isolation, revocation, CSRF/origin, file types, external read-only through direct requests, audit immutability, password reset single use, deactivation, lockout, configurable roles).
- Browser check (Chromium) at 1366 px and 390 px: sign-in → MFA enrolment → dashboard → section → workspace → upload; no horizontal scroll.

## Not yet built (by phase)
- Phase 3+: questionnaires, plans, tasks, finance, progress updates, PDF/Excel exports, email invitations for external viewers, job scheduler, investors, AI assistant.

## External dependencies (not available yet)
- Outlook SMTP for info@saraydar.com (SMTP_HOST=smtp.office365.com, SMTP_PORT=587, SMTP_USER, SMTP_PASS, MAIL_FROM; Authenticated SMTP must be enabled on the mailbox)
- Paid Render tier before real use (always-on jobs, non-expiring DB)
- DNS CNAME portal.saraydar.com → saraydar-api.onrender.com (+ add the custom domain in Render)
- AI API key (optional)

## Known issues
- Free database expires 2026-11-22.
- Database password was shared in chat on 2026-10-23 — rotate it.
- Files are stored in Postgres; the free 1 GB database limits photo volume. Move to object storage before heavy photo use.
