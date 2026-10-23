# Requirement-to-implementation checklist

Status as of 24 Oct 2026, after Phase 7.

**Legend**

| Status | Meaning |
|---|---|
| ✅ Tested | Implemented and covered by automated tests in `server/test` (108 passing). |
| ✅ Built | Implemented and checked by hand or screenshot, without an automated test. |
| ⏳ External | Needs a service or a step from the owner. |
| ⚠️ Partial | Partly done. The note says what is missing. |
| ❌ Not done | Not implemented. |
| 🔁 Owner decision | Deliberately changed from the specification at the owner's request. |

## Acceptance tests (spec §17)

| # | Requirement | Status | Evidence / note |
|---|---|---|---|
| A | Login/logout, recovery, role restrictions | ✅ Tested | `portal.test.js`, `mfa-off.test.js` |
| A | Super Admin MFA | 🔁 Owner decision | Off by default since 23 Oct. `REQUIRE_MFA=1` turns it back on. That code path is still tested. |
| A | Records and files persist after logout, restart and restore | ✅ Tested | Postgres storage. The restore rehearsal is in `docs/BACKUP.md`. |
| A | Direct API, download, export and AI requests to other workspaces refused | ✅ Tested | Isolation tests in every phase; `external.test.js`; `assistant.test.js`. |
| B | Two or more workspaces per kind; independent; archive keeps history | ✅ Tested | Phase 2–6 tests. |
| C | Questionnaire with unknowns, plan approval and baseline, photo updates, permissions, photos don't change progress | ✅ Tested | `projects.test.js` |
| D | Fee invoice, partial payment, allocation, receipt; client spending kept separate; approval ≠ payment | ✅ Tested | `client-projects.test.js` |
| E | Owners, units, leases, opening balances, no overlapping leases, one invoice per period under retries and concurrency, true delivery status, payments, credits, deposits, transfers, maintenance, Apartment 13 history, shared-cost split, owner statement reconciliation | ✅ Tested | `properties.test.js` |
| F | Real PDF and .xlsx in each section, with permissions and period filters | ✅ Tested | `export-nav.test.js` plus section tests |
| F | Arabic RTL screens and PDFs | 🔁 Owner decision | English-only interface (decided 23 Oct). IBM Plex Sans Arabic is not loaded. RTL is not implemented. |
| F | Mobile photo upload, BHD 3-decimal maths | ✅ Built / ✅ Tested | File inputs accept phone camera images (JPEG/PNG/WebP; HEIC is stored but has no thumbnail). Money maths is tested. |
| F | Job retry and idempotency, reversals, concurrency | ✅ Tested | Billing job, fee and investor idempotency keys, row locks |
| F | Backup and restore with a documented procedure | ✅ Tested (manual run) | `docs/BACKUP.md`: backup → restore → identical fingerprint, 0 damaged attachments, app serves restored files |
| F | Works without payment gateway or AI; dependencies disclosed | ✅ Tested | Assistant shows "not configured"; outbox shows "not configured" |
| G | Invite → activate → open assigned workspace on mobile | ✅ Tested + screenshots | `external.test.js`; 390 px screenshots with no horizontal scroll |
| G | Client, Owner, Investor, Seller and Buyer viewers; one account with several workspaces; unassigned items absent from lists, search, exports and URLs | ✅ Tested | `external.test.js` (four sections, one account, filter, 404s, `/search` → `/my`) |
| G | Drafts, internal notes, restricted finances, other investors and tenant details absent from responses | ✅ Tested | Checked on the server-rendered HTML, which is the full response. There is no separate JSON API for external viewers. |
| G | Write attempts by external viewers denied, records unchanged | ✅ Tested | Middleware refuses every POST except own account; row counts compared |
| G | Separate export/download grants, invitation expiry, single use, revocation keeps history, "not emailed" when no provider | ✅ Tested | |
| G | Arabic RTL in portals | 🔁 Owner decision | English only |
| H | Two investors in one project, one also in a second project, no automatic equity | ✅ Tested | |
| H | Partial contribution confirmed, acknowledgment, remaining commitment, funding summary, no revenue, retry gives no duplicate | ✅ Tested | Idempotency key plus unique reference per investor |
| H | Approved capital return and distribution, statement, audit | ✅ Tested | |
| H | Investor invited to one project sees progress and own statement only, read-only | ✅ Tested | |
| I | Seller and buyer flows, follow-ups, matching, shortlist, offers, deals, commission, reports | ✅ Tested | `sales.test.js` |
| I | Seller and buyer viewer portals | ✅ Tested | `external.test.js` |

## Platform and operations

| Requirement | Status | Note |
|---|---|---|
| Company website "Company Portal" button | ⏳ External | Snippet and DNS steps are in `ADMIN_GUIDE.md` §8. saraydar.com has not been changed. |
| portal.saraydar.com | ⏳ External | Needs the DNS CNAME plus the Render custom domain |
| Email (Outlook, info@saraydar.com) | ⏳ External | SMTP variables are not set. All mail stays in the Outbox as "not configured". |
| Always-on background jobs | ⏳ External | Render free tier sleeps when idle. A paid plan is needed. |
| Production database | ⏳ External | Free Render database expires 22 Nov 2026 and has no backups. |
| Nightly encrypted backups | ⏳ External | Workflow is in the repo. It needs two GitHub secrets. |
| AI assistant | ✅ Tested (mock provider) / ⏳ External | Needs `ANTHROPIC_API_KEY`. It has not been tried against the live provider from here. |
| Attachments storage | ⚠️ Partial | Stored in Postgres, which is fine for now. Move to object storage before photo volume grows past roughly 1 GB. |
| Arabic interface | 🔁 Owner decision | English only |
| VAT | 🔁 Owner decision | No VAT for now. VAT invoices need the VAT number in company details. |
| Payment gateway / online payment | ❌ Not done (by spec) | Not in this release. The ledger is ready for it later. |
| Tenant self-service portal | ❌ Not done | The Tenant role exists, but there is no tenant workflow. Staff record tenant requests. |
| Configurable sales pipeline stages; multi-currency conversion | ❌ Not done | Fixed stages. Currencies are never mixed in totals. |
| Automatic monthly management-fee issuing | ⚠️ Partial | Drafts are made per month and Finance issues them. Rent invoicing is automatic. |
| Demonstration data, labelled and isolated | ✅ Built | `scripts/seed-demo.js` refuses non-demo databases and production. Run and checked 24 Oct. |
| Admin and user guides | ✅ Built | `ADMIN_GUIDE.md`, `USER_GUIDE.md` |
