# SarayDar Management System — Super Admin guide

Address: **portal.saraydar.com** (once DNS is set; until then use the Render address `saraydar-api.onrender.com`).

## 1. First steps
1. Sign in with the administrator account. Change the password: **Account › Change password**.
2. **Administration › Agreements › Company details:** enter the legal name, address, CR number and bank details. Upload the A4 letterhead. Add the VAT number only when VAT registration starts.
3. **Administration › Users:** add staff. Give each person a role:
   - Project Manager, Finance, Engineer, Viewer, Brokerage Agent or Sales Manager.
   - What each role can do is set in **Administration › Roles**.
   - The system creates a temporary password. The person must change it at their first sign-in.
4. **Administration › System:** shows whether email (Outlook SMTP), background jobs and the AI assistant are configured.

## 2. Workspaces and staff access
- Each project, property, sale listing and acquisition request is its own workspace. Staff see only the workspaces they are added to. The Super Admin sees all of them.
- To add staff to a workspace, open it and go to **Access & Invitations › Add a person**. Their role there can be Manager, Editor, Contributor or Viewer.
- Removing access takes effect on the person's next page load. Their history in the workspace is kept.

## 3. External viewers: invitations (clients, owners, investors, sellers, buyers)
External viewers are **view-only**. They cannot create, edit, upload, comment, approve or confirm payments. They also cannot invite anyone else. Every write attempt is refused by the server, not only hidden in the screen.

To invite someone:
1. Create the workspace and start managing it first. Nothing is sent automatically when a workspace is created.
2. Open the workspace. Go to **Access & Invitations › Invite an external viewer**.
3. Choose the contact, or type a name and email. Then choose the role that fits the workspace:
   - Development project: Client Viewer or Investor Viewer.
   - Client project: Client Viewer.
   - Property: Owner Viewer.
   - Sale listing: Seller Viewer.
   - Search request: Buyer Viewer.
4. Tick anything extra they may see:
   - **Statements:** their own fee invoices and receipts, owner statement, or investor contribution statement.
   - **Offers & deal progress:** sales only. Other buyers' details are never shown.
   - **Download attachments.**
   - **Save pages as PDF/Excel.**
5. Fill in **How did you confirm this is the right person and address?** and tick the confirmation box.
6. Click **Create invitation**.
   - If Outlook email is configured, the invitation is emailed. It shows as "Emailed" only when the mail server accepts the message.
   - If email is not configured, the screen shows the one-time link once. Send it yourself through a channel you trust. The list shows "Not emailed — email not configured".
7. The link works **once** and expires after **7 days**.
   - **Resend** creates a new link, and the old link stops working.
   - **Revoke** cancels a pending invitation.
8. The person opens the link and sets a password. If they already have a login, they enter their existing password instead. Then they land on their portal.

One external account can be invited to several workspaces, and each one is granted separately. Being a client, owner or investor of record does **not** give portal access by itself.

**Preview:** **Access & Invitations › Preview the external view** shows a page exactly as a viewer role sees it. The **Preview** button next to each external viewer shows the page with that person's settings.

**Changing what someone sees:** use **What external viewers can see** (tick boxes, then Save).

**Removing access:** in **People with access**, click **Remove**. This takes effect immediately. The investment, ledger and audit history is kept. Files the person already downloaded cannot be recalled.

## 4. What external viewers see (published information only)

| Workspace | They see | Never shown |
|---|---|---|
| Development / client project | Status and stage. Progress updates that staff chose to **show to external viewers**, with their photos. Phases and milestones from the approved plan. Documents marked **Published**. Client approvals marked visible. | Drafts, issues, internal notes, workforce, budget, costs, risks, other investors |
| Investor (development project) | All of the above, plus **My Investment** if statements are granted. This covers only their own participation in this project: agreed contribution, confirmed receipts, outstanding and overdue amounts, capital returned, distributions and the statement. | Other investors, their terms and statements; project bank records and margins; other projects |
| Property (owner) | Units and their status. Maintenance that staff chose to **show to owner**, with its photos. Owner statement if granted. Published documents. | Tenant names and contacts, internal notes, costs of unpublished jobs |
| Sale listing (seller) | Approved listing content and client-approved photos. Published marketing. Viewing summaries written for the owner. Offers and deal progress if granted (buyers are not named). Their own fees if granted. | Buyer identities and budgets, co-broker terms, internal notes, unpublished negotiation notes |
| Search request (buyer) | Their search criteria. Properties **published** to their shortlist, with approved photos. Their viewings. Offers and deal progress if granted. Their own fees if granted. | Seller's minimum price, other buyers, internal notes, unpublished options, co-broker arrangements |

How staff publish each item:

- **Progress update:** tick "show to external viewers" when publishing, or use the button on the update page.
- **Maintenance:** on the request page, use "Show to owner".
- **Documents:** set "Visible to: also external viewers" when uploading.
- **Listing photos:** choose "Client-approved for marketing".
- **Shortlist:** publish the item (this needs the 14-day recheck).
- **Approvals:** tick "client can see status".

## 5. Investors & Funding (development projects)
- In the project, open **Investors & Funding › Add an investor participation**. Pick an existing contact or create the investor.
- Record only what the agreement says:
  - participation type (or "not yet confirmed"), currency and agreed contribution;
  - payment schedule, dates and agreement reference;
  - ownership, profit and return terms.
- Nothing is calculated from contributions. A contribution never creates an ownership percentage or a right to profit.
- One investor can be in several projects. Each project has its own participation and agreement.
- **Contributions** follow two steps:
  - Staff record a transfer the investor reported. It shows as "Reported — not yet confirmed".
  - **Finance** checks the bank statement and clicks **Confirm received**. Only then does it count as received, and it gets an acknowledgment number (ACK-YYYY-NNNN). The acknowledgment page can be saved as a PDF.
  - Duplicate bank references and repeated form submissions are refused. Corrections are made by **Reverse**, with a reason.
- **Capital returns, distributions and adjustments** are entered by Finance only. Each needs an approval reference. A distribution is allowed only after profit-sharing terms are recorded and confirmed. A capital return cannot exceed the net capital invested. Recording one does **not** pay anything: it records a bank payment already made.
- Investor money is project financing. It is not sale revenue or a SarayDar fee, and it does not reduce construction cost.
- Investor profile: click the investor's name to see all their participations in projects you can open.
- To let an investor view their statement, invite them as **Investor Viewer** from that project's Access & Invitations, linked to their contact record, with **Statements** ticked.

## 6. Sales & Acquisition controls (summary)
- **Mandates.** Nothing can be marketed, viewed or offered until the mandate is active and the authority is verified. An expired mandate blocks new activity.
- **Asking-price changes** keep the reason and the seller's authorisation. The confidential minimum price is never shown outside the staff file.
- **Buyer follow-up.** Each enquiry needs a next follow-up date or a recorded reason. Overdue and stale lists are shown on the section page.
- **Commission.** The invoice is drafted from the mandate, with the calculation shown. There is one invoice per deal and side. Gross sale value is never counted as SarayDar revenue.

## 7. Email, jobs, AI, backups
- **Email (Microsoft 365).** Recommended: an Entra app registration with the Microsoft Graph **Mail.Send** application permission (admin consent), then set `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET` and `MAIL_FROM=SarayDar <info@saraydar.com>` on Render. No mailbox password is used, and it keeps working after Microsoft switches off password-based SMTP for apps (end of December 2026). The older SMTP settings (`SMTP_HOST` etc.) still work until then. Use **Administration › System › Send test email** to check. Until configured, every message stays in **Administration › Outbox** with status "Not configured". The client secret expires (you choose 6–24 months): renew it in Entra and update `MS_CLIENT_SECRET` before then.
- **Background jobs** (rent invoicing, reminders and service tasks) run hourly while the service is awake. The paid Render plan is needed for them to run reliably.
- **AI assistant:** see `docs/AI.md`.
- **Backups:** see `docs/BACKUP.md`. Turn on the nightly encrypted backup by adding the two GitHub secrets.

## 8. Company website button
Add this to saraydar.com wherever the "Company Portal" button should appear:

```html
<a href="https://portal.saraydar.com/login" class="portal-button" rel="noopener">Company Portal</a>
```

For the address to work, add a DNS **CNAME** record `portal` → `saraydar-api.onrender.com` wherever saraydar.com's DNS is managed. Then add `portal.saraydar.com` under Render › saraydar-api › Settings › Custom Domains. Render issues the HTTPS certificate automatically, and you should set `APP_URL=https://portal.saraydar.com` on Render. The website itself has not been changed by this project.

## 9. Demonstration data
`server/scripts/seed-demo.js` loads clearly labelled demonstration records (every name starts with "DEMO"). It refuses to run unless the database name contains "demo" or `DEMO_SEED=yes` is set, and it never runs with `NODE_ENV=production`. Never load it into the live database.
