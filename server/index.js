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

  const corsOrigins = (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean);
  const app = createApp({ pool, jwtSecret: secret, corsOrigins });
  const port = parseInt(process.env.PORT, 10) || 10000;
  app.listen(port, '0.0.0.0', () => console.log(`Saraydar API listening on ${port}; allowed origins: ${corsOrigins.join(', ') || 'none'}`));
}

main().catch(e => { console.error(e); process.exit(1); });
