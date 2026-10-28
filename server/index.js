'use strict';
const { Pool } = require('pg');
const db = require('./db');
const { createApp } = require('./app');

async function main() {
  const url = process.env.DATABASE_URL;
  const secret = process.env.JWT_SECRET;
  if (!url) throw new Error('DATABASE_URL is not set');
  let host = '?';
  try { const u = new URL(url); host = `${u.protocol}//${u.hostname}${u.port ? ':' + u.port : ''}${u.pathname}`; } catch (e) { host = 'not a valid URL'; }
  console.log(`Database address: ${host}`);
  if (!/^postgres(ql)?:\/\//.test(url)) throw new Error('DATABASE_URL must start with postgresql:// — copy the Database URL from the saraydar-db page');
  if (!secret || secret.length < 32) throw new Error('JWT_SECRET must be set to at least 32 characters');

  // Render's private database address needs no SSL; the public address does.
  const useSsl = process.env.PGSSL === '1' || /\.render\.com/.test(url);
  const pool = new Pool({ connectionString: url, max: 10, connectionTimeoutMillis: 15000, ssl: useSsl ? { rejectUnauthorized: false } : undefined });
  pool.on('error', e => console.error('Database error', e.message));

  await db.migrate(pool);
  const loaded = await db.seed(pool);
  if (loaded) console.log(`Loaded ${loaded} starting records`);
  await db.ensureAdmin(pool);
  const moved = await require('./lib/abuquwa-import').importAbuquwa(pool);
  if (moved) console.log(`Moved ${moved} Abuquwa tasks into workspace DEV-2026-001`);
  await require('./lib/master-store').convertExisting(pool);   // one time: existing projects onto the construction master plan
  // one time (owner request 2026-10-28): the client budget line "Main contract" is now called "Project construction"
  if (!(await pool.query("select 1 from app_state where key = 'budget_line_rename_v1'")).rowCount) {
    const r = await pool.query("update budget_lines set description = 'Project construction' where description = 'Main contract' and workspace_id in (select id from workspaces where section = 'cpm')");
    await pool.query("insert into app_state (key, value) values ('budget_line_rename_v1', $1) on conflict (key) do nothing", [`${new Date().toISOString()}: ${r.rowCount} lines`]);
  }

  const corsOrigins = (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean);
  const { createMailer } = require('./lib/mailer');
  const mailer = createMailer({ pool, env: process.env });
  const app = createApp({ pool, jwtSecret: secret, corsOrigins, mailer });
  // Background jobs (Bahrain time): automatic rent invoicing, reminders and recurring service tasks, every hour.
  // Safe to overlap or retry: an advisory lock allows one run at a time and every step is idempotent.
  if (process.env.DISABLE_JOBS !== '1') {
    const billing = require('./lib/billing');
    const run = () => billing.runBilling(pool, mailer, {}).then(() => billing.generateServiceTasks(pool, {})).catch(e => console.error('Background job failed:', e.message));
    setTimeout(run, 60 * 1000);
    setInterval(run, 60 * 60 * 1000);
  }
  const port = parseInt(process.env.PORT, 10) || 10000;
  app.listen(port, '0.0.0.0', () => console.log(`Saraydar API listening on ${port}; allowed origins: ${corsOrigins.join(', ') || 'none'}`));
}

main().catch(e => { console.error(e); process.exit(1); });
