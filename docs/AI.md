# AI assistant

The assistant is optional, and the portal works fully without it. Without a key, each workspace's **Assistant** tab says "not configured". No answers are simulated.

## Turning it on (Super Admin)

On Render, open `saraydar-api` › Environment and add the following:

| Variable | Value |
|---|---|
| `ANTHROPIC_API_KEY` | Required. An API key from console.anthropic.com. Usage is billed by Anthropic to that account. |
| `AI_MODEL` | Optional. Defaults to `claude-sonnet-5-5`. |
| `AI_API_URL` | Optional. Leave it empty. It is used only for testing. |

Then redeploy the service.

## What it can do

The assistant is for SarayDar staff only, and it works inside one workspace at a time:

- It answers questions about that workspace and summarises its status.
- It points out overdue or at-risk items.
- It suggests next steps for a person to review.

Every answer is labelled **AI suggestion — not verified**. Each answer also lists the pages its facts came from.

It cannot create, edit, approve, publish, send or pay anything. It has no tools: it only returns text.

External viewers (clients, owners, investors, sellers and buyers) never see it. It is not part of the view-only portal.

## What is sent to the provider

Context is built on the server from the one workspace being viewed. It includes only records the person asking can already open.

**Sent:**
- The question.
- The workspace name, reference, type, status, stage and location.
- Open tasks: title, status, progress and due date.
- Published progress updates: date, title, work done, next steps and issues.
- Open register items.
- For properties: unit references, unit types and statuses; leases ending within 90 days (unit and date only); open maintenance titles and statuses.
- For sale listings: listing status and public property facts, including the public asking price; counts of viewings and offers by status.
- For acquisition requests: the brief, without the budget; shortlist counts.
- Up to 15 recent activity summaries.

**Never sent:**
- Budgets, costs, invoices, payments, rent amounts, fees and investor figures.
- Names and contact details of people: tenants, buyers, sellers, investors and staff.
- Buyer budgets, the seller's confidential minimum price, access notes and internal notes.
- Files and photos.
- Anything from another workspace.

## Records kept

- Each question is recorded in the audit log (`ai.asked`). The record holds the first 140 characters of the question, the model, and the size of the context.
- Answers are not stored.
- Each person can ask up to 30 questions per hour.

If the provider fails, the page shows its error code and confirms that nothing was changed.

Anthropic's commercial terms apply to API data. Under those terms, API inputs and outputs are not used for model training by default. Check the current terms before enabling the assistant.
