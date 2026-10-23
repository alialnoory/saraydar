'use strict';
// Checks a SarayDar database after a restore (or before a backup) and prints a fingerprint to compare:
// row counts per table, applied migrations, and an integrity check of every stored attachment (SHA-256).
//   node scripts/verify.js postgres://...      (exit code 1 if any attachment is damaged)
const { Client } = require('pg');
(async () => {
  const url = process.argv[2] || process.env.DATABASE_URL;
  if (!url) { console.error('Usage: node scripts/verify.js <database URL>'); process.exit(2); }
  const c = new Client({ connectionString: url, ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false } });
  await c.connect();
  const tables = (await c.query("select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by 1")).rows.map(r => r.table_name);
  const counts = {};
  for (const t of tables) counts[t] = Number((await c.query(`select count(*) from "${t}"`)).rows[0].count);
  const migrations = (await c.query('select name from schema_migrations order by name')).rows.map(r => r.name);
  const files = (await c.query("select count(*)::int as n, count(*) filter (where encode(sha256(data), 'hex') <> sha256)::int as bad, coalesce(sum(size),0)::bigint as bytes from files")).rows[0];
  const audit = (await c.query('select coalesce(max(id),0)::bigint as last from audit_events')).rows[0].last;
  await c.end();
  const out = { tables: tables.length, migrations, rows: counts, attachments: { count: files.n, bytes: Number(files.bytes), damaged: files.bad }, last_audit_event: Number(audit) };
  console.log(JSON.stringify(out, null, 2));
  if (files.bad) { console.error(`${files.bad} attachment(s) do not match their checksum.`); process.exit(1); }
})().catch(e => { console.error(e.message); process.exit(2); });
