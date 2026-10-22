# Abuquwa Villas online: setup

The site runs on Netlify. Logins and data run on Supabase. Setup takes about 15 minutes and is done once.

## 1. Create the Supabase project

1. Sign up at [supabase.com](https://supabase.com) and create a new project named `saraydar`.
2. Choose the region closest to Bahrain (Frankfurt or Mumbai) and set a strong database password. Keep it somewhere safe.

## 2. Create the tables, access rules and current data

1. In the project, open **SQL Editor → New query**.
2. Paste the whole of [`supabase/setup.sql`](supabase/setup.sql) and click **Run**.

This creates the tables, the four roles, a change history of every edit, and loads the current project data.

## 3. Lock down sign-ups

Open **Authentication → Sign In / Providers**:

- Turn **off** "Allow new users to sign up", so only people you add can get in.

Open **Authentication → URL Configuration**:

- **Site URL**: `https://saraydar.netlify.app` (or `https://projects.saraydar.com` once connected)
- **Redirect URLs**: add `https://saraydar.netlify.app/abuquwa-villas/`

## 4. Create your own login first

**Authentication → Users → Add user → Create new user**: your email, a password, tick **Auto Confirm User**.

The first user created becomes **Admin** automatically.

## 5. Connect the site

Open **Project Settings → API** and copy:

- **Project URL**
- **anon public** key (never the `service_role` key)

Put both into [`abuquwa-villas/config.js`](abuquwa-villas/config.js) and commit. Netlify redeploys, and the site shows the sign-in screen.

## 6. Add your team

For each person: **Authentication → Users → Add user → Create new user** with their email, a temporary password and **Auto Confirm User** ticked.

They start as **Viewer**. Sign in to the site, open the **Users** tab and set their role:

| Role | Can do |
| --- | --- |
| Admin | Everything, plus managing users and roles |
| Editor | Add, edit and delete all project records |
| Site | Add and edit site log entries, update task progress |
| Viewer | Read only |

Roles are enforced by the database, not only hidden in the page. Every change is recorded in the `record_history` table (who, when, before and after), viewable in Supabase → Table Editor.

## After the switch

Once logins are live, ask for the public `data` export to be blocked again in `netlify.toml`, so the project figures are only visible after sign-in.
