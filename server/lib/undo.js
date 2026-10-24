'use strict';
// Undo / redo of a person's own edits to details. Only these tables and columns can be restored; financial
// records (invoices, payments, ledgers) are never included: they are corrected by recorded reversals.
const UNDO_TABLES = {
  workspaces: { key: 'id', cols: ['name', 'location', 'stage', 'status', 'manager_id', 'archived_at'] },
  parties: { key: 'id', cols: ['kind', 'name', 'email', 'phone', 'notes', 'id_number', 'address', 'representative', 'representative_title', 'representative_cpr', 'signs_personally', 'contact_person', 'representatives', 'preferred_contact', 'billing_name', 'billing_address', 'billing_email', 'tax_number', 'client_reference', 'approval_authorities', 'communication_notes', 'preferred_language', 'lead_source', 'agent_id'] },
  buyer_profiles: { key: 'party_id', cols: ['status', 'purpose', 'types', 'locations', 'budget_min_minor', 'budget_max_minor', 'currency', 'size_min_m2', 'size_max_m2', 'bedrooms_min', 'timing', 'funding', 'notes'] },
  tasks: { key: 'id', cols: ['phase_id', 'parent_id', 'title', 'owner_text', 'owner_user', 'start_date', 'due_date', 'actual_start', 'actual_finish', 'status', 'progress', 'weight', 'is_milestone', 'notes', 'archived_at'] },
  phases: { key: 'id', cols: ['name', 'sort', 'weight', 'archived_at'] },
  register_items: { key: 'id', cols: ['title', 'description', 'owner_text', 'status', 'likelihood', 'impact', 'due_date', 'suggested', 'archived_at'] },
  plots: { key: 'id', cols: ['ref', 'title_deed', 'area_m2', 'frontage_m', 'depth_m', 'location', 'tenure', 'owner_text', 'zoning', 'status', 'purchase_price_minor', 'purchase_date', 'notes'] },
  units: { key: 'id', cols: ['ref', 'floor', 'unit_type', 'area_m2', 'bedrooms', 'features', 'condition', 'market_rent_minor', 'notes', 'archived_at'] },
  dev_units: { key: 'id', cols: ['name', 'unit_type', 'area_m2', 'status', 'list_price_minor', 'notes', 'plot_id'] }
};
const jb = cols => `jsonb_build_object(${cols.map(c => `'${c}', ${c}`).join(', ')})`;

async function snap(db, table, id) {
  const t = UNDO_TABLES[table];
  const r = (await db.query(`select ${jb(t.cols)} as j from ${table} where ${t.key} = $1`, [id])).rows[0];
  return r ? r.j : null;
}

// Wrap a save: snapshots the rows before and after `fn` and, when something changed, records an undo entry.
// targets: [[table, id], ...]
async function track(db, user, { label, workspaceId = null, returnTo = null, targets }, fn) {
  const before = [];
  for (const [table, id] of targets) before.push(await snap(db, table, id));
  const out = await fn();
  const changes = [];
  for (let i = 0; i < targets.length; i++) {
    const [table, id] = targets[i];
    const after = await snap(db, table, id);
    if (before[i] && after && JSON.stringify(before[i]) !== JSON.stringify(after)) changes.push({ table, id, before: before[i], after });
  }
  if (changes.length) {
    await db.query('update undo_log set dead = true where user_id = $1 and undone_at is not null and not dead', [user.id]);
    await db.query('insert into undo_log (user_id, workspace_id, label, changes, return_to) values ($1,$2,$3,$4,$5)', [user.id, workspaceId, String(label).slice(0, 200), JSON.stringify(changes), returnTo]);
  }
  return out;
}

// Apply one side (before or after) of an entry; refuses if any row no longer holds the other side.
async function apply(db, entry, to) {
  const from = to === 'before' ? 'after' : 'before';
  for (const c of entry.changes) {
    const t = UNDO_TABLES[c.table];
    if (!t) throw Object.assign(new Error('This change cannot be undone.'), { status: 400 });
    const cols = t.cols.join(', ');
    const n = (await db.query(`update ${c.table} set (${cols}) = (select ${cols} from jsonb_populate_record(null::${c.table}, $2::jsonb)) where ${t.key} = $1 and ${jb(t.cols)} = $3::jsonb`,
      [c.id, JSON.stringify(c[to]), JSON.stringify(c[from])])).rowCount;
    if (!n) throw Object.assign(new Error(`It can't be ${to === 'before' ? 'undone' : 'redone'} because the record was changed again since (by you or someone else). Make the change by hand instead.`), { status: 409 });
  }
}

async function latest(db, userId) {
  const undo = (await db.query("select id, label from undo_log where user_id = $1 and undone_at is null and created_at > now() - interval '24 hours' order by id desc limit 1", [userId])).rows[0] || null;
  const redo = (await db.query("select id, label from undo_log where user_id = $1 and undone_at is not null and not dead and created_at > now() - interval '24 hours' order by undone_at desc, id desc limit 1", [userId])).rows[0] || null;
  return { undo, redo };
}

module.exports = { UNDO_TABLES, track, apply, latest, snap };
