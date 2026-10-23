'use strict';
// Shared handling for photos and documents attached to records (maintenance, inspections, payments…).
const crypto = require('crypto');
const sharp = require('sharp');

async function prepare(files, sniff) {
  const out = [];
  for (const f of files || []) {
    const t = sniff(f.buffer, f.originalname);
    if (!t) throw Object.assign(new Error(`“${f.originalname}” is not an accepted file type (photos, PDF, Office documents, text).`), { status: 400 });
    let thumb = null, width = null, height = null;
    if (t.image) {
      try {
        const img = sharp(f.buffer, { failOn: 'none' }).rotate();
        const meta = await img.metadata(); width = meta.width || null; height = meta.height || null;
        thumb = await img.resize(480, 480, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 74 }).toBuffer();
      } catch { /* keep the file without a thumbnail */ }
    }
    out.push({ name: String(f.originalname || 'file').replace(/[/\\]/g, '_').slice(-150), mime: t.mime, size: f.size, sha: crypto.createHash('sha256').update(f.buffer).digest('hex'), data: f.buffer, thumb, width, height });
  }
  return out;
}

async function insert(db, { workspaceId, entity, entityId, files, userId, tag = null, caption = null, observedOn = null }) {
  const ids = [];
  for (const p of files) {
    ids.push((await db.query(`insert into files (workspace_id, entity, entity_id, original_name, mime, size, sha256, data, thumb, width, height, caption, observed_on, uploaded_by, tag)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) returning id`,
      [workspaceId, entity, String(entityId), p.name, p.mime, p.size, p.sha, p.data, p.thumb, p.width, p.height, caption, observedOn, userId, tag])).rows[0].id);
  }
  return ids;
}

const list = async (db, workspaceId, entity, entityIds) => entityIds.length ? (await db.query(
  `select id, entity_id, original_name, mime, tag, caption, uploaded_at, thumb is not null as has_thumb from files
    where workspace_id = $1 and entity = $2 and entity_id = any($3::text[]) and archived_at is null order by uploaded_at`, [workspaceId, entity, entityIds.map(String)])).rows : [];

module.exports = { prepare, insert, list };
