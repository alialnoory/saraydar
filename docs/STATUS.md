# SarayDar Management System — Status

Last updated: 2026-10-23

## Live today
- Abuquwa Villas project tracker (single project) at https://saraydar.netlify.app, API on Render (`saraydar-api`), Postgres `saraydar-db` (free, expires 2026-11-22).
- Logins with roles admin/editor/site/viewer, change history, user management. Tested (server tests 15/15, browser test at phone width).

## Phase status
| Phase | State |
|---|---|
| 1 Architecture, data model, screen map, questions | Done (`docs/ARCHITECTURE.md`); Q1–Q4 answered |
| Design preview | Published for approval (6 boards, English only) |
| 2 Foundation | Not started |
| 3 Development projects | Not started |
| 4 Client projects | Not started |
| 5 Property management | Not started |
| 6 Sales & Acquisition | Not started |
| 7 Portals, investors, exports, AI, hardening | Not started |

## External dependencies (not available yet)
- Paid Render tier (always-on jobs, non-expiring DB)
- SMTP host + credentials for info@saraydar.com
- Official logo + brand colours
- AI API key (optional)
- DNS CNAME for portal.saraydar.com

## Known issues
- Free database expires 2026-11-22.
- Database password was shared in chat on 2026-10-23 — rotate it.
