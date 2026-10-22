# Abuquwa Villas — Project Control System

Saraydar Real Estate · exported 22 Oct 2026

## Contents

| File | What it is |
| --- | --- |
| `index.html` | The full system: interface, Saraydar theme and all logic in one file |
| `data/all-data.json` | Every record in the system, grouped by section |
| `data/tasks.json` | Schedule: 36 tasks across 7 phases and the sales track |
| `data/costs.json` | Budget lines |
| `data/payments.json` | Payments, each linked to a cost line by `costId` |
| `data/units.json` | The 4 villas: status, price, buyer, amount collected |
| `data/risks.json` | Risk register |
| `data/log.json` | Site log entries |
| `data/meta.json` | Project name, developer, start and target handover dates |

## Important: how the data works

`index.html` stores and reads its data through Claude's built-in database
(`window.claude.use("db")`). Opened on its own in a browser, or hosted on
saraydar.com, the page loads but shows "Project data is not available in
this view", because that database exists only on claude.ai.

To run it on your own domain with usernames and passwords, the data
layer needs to be connected to your own backend (for example Supabase).
The changes are contained:

1. Replace the `boot` block at the end of the script with a login screen
   and calls to your backend.
2. Replace `db.collection(c).onSnapshot(...)`, `.set(...)` and `.delete(...)`
   with the equivalent calls of your database.
3. Import the files in `data/` as the starting records. Field names match
   the forms in the page exactly.

Everything else (views, calculations, forms, theme) works as is.

## Data notes

- Amounts are in Bahraini dinars (BD), stored as plain numbers.
- Dates are ISO strings (`YYYY-MM-DD`).
- The land payment has no date recorded yet.
