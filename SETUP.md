# Saraydar project system: setup

Visitors use **https://portal.saraydar.com**, served by Netlify. Netlify passes every request through (a proxy, not a redirect) to the
Render service `saraydar-api` (Node server plus a Postgres database), which renders all pages, handles sign-in and stores the data.
The browser never leaves portal.saraydar.com. See `netlify.toml`.
Tables, the starting project data and the first administrator are created automatically on first start.

## 1. Deploy on Render (about 5 minutes, works from a phone)
1. render.com → New → Blueprint → connect GitHub repo `alialnoory/saraydar`.
2. Enter `ADMIN_EMAIL` and `ADMIN_PASSWORD` (10+ characters) when asked, then Apply.
3. When both services show Live, open the `saraydar-api` service and copy its address (`https://saraydar-api-xxxx.onrender.com`).

## 2. Connect the page
Put that address in `abuquwa-villas/config.js`:

    window.SARAYDAR_CONFIG = { apiUrl: 'https://saraydar-api-xxxx.onrender.com' };

Commit. Netlify redeploys. Then block the public data snapshot by adding to `netlify.toml`:

    [[redirects]]
      from = "/abuquwa-villas/data/*"
      to = "/404.html"
      status = 404
      force = true

## 3. Use it
Sign in with the administrator email and password. Users tab → add people with a role (Admin, Editor, Site, Viewer).

## Notes
- Public address: on Render set `APP_URL=https://portal.saraydar.com`, add it to `CORS_ORIGINS` (comma separated) and set `TRUST_PROXY_HOPS=2`.
  Another public address can be added in `PUBLIC_ORIGINS` (comma separated). Without these, sign-in through Netlify is refused as a different origin.
- Lost the administrator password: on Render set `ADMIN_EMAIL`, `ADMIN_PASSWORD` and `ADMIN_FORCE_RESET=1`, redeploy, sign in, then remove `ADMIN_FORCE_RESET`.
- Plans in `render.yaml` are paid (roughly $13/month together). Render's free plans exist, but the free web service sleeps when idle and the free database is temporary; check Render pricing.
- Tests: `cd server && TEST_DATABASE_URL=postgres://... npm test`.
