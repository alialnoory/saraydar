'use strict';
// Undo / Redo buttons beside Back and Home (staff only). See lib/undo.js for what can be undone.
const U = require('../lib/undo');
const { safeNext } = require('./auth');

function mountUndo(r, ctx) {
  const { pool, core, Forbidden } = ctx;
  // every staff GET page knows whether there is something to undo or redo
  r.use(async (req, res, next) => {
    try {
      if (req.method === 'GET' && req.user && !core.isExternal(req.user) && !req.query.export) req.undoState = await U.latest(pool, req.user.id);
      next();
    } catch (e) { next(e); }
  });
  async function act(req, res, kind) {
    if (core.isExternal(req.user)) throw new Forbidden();
    const back = safeNext(String(req.body.back || '')) || '/';
    const sql = kind === 'undo'
      ? "select * from undo_log where user_id = $1 and undone_at is null and created_at > now() - interval '24 hours' order by id desc limit 1 for update"
      : "select * from undo_log where user_id = $1 and undone_at is not null and not dead and created_at > now() - interval '24 hours' order by undone_at desc, id desc limit 1 for update";
    const result = await core.inTx(async db => {
      const e = (await db.query(sql, [req.user.id])).rows[0];
      if (!e) return { msg: kind === 'undo' ? 'nothing_to_undo' : 'nothing_to_redo' };
      if (e.workspace_id) {
        const a = await core.workspaceAccess(req.user, e.workspace_id);
        if (!a || !core.canContribute(a)) throw new Forbidden('You no longer have edit access to this workspace.');
      }
      await U.apply(db, e, kind === 'undo' ? 'before' : 'after');
      await db.query(`update undo_log set undone_at = ${kind === 'undo' ? 'now()' : 'null'} where id = $1`, [e.id]);
      await core.audit(db, { actor: req.user, workspaceId: e.workspace_id, action: `edit.${kind}`, entity: 'undo', entityId: String(e.id), summary: `${kind === 'undo' ? 'Undid' : 'Redid'}: ${e.label}`, ip: req.ip });
      return { msg: kind === 'undo' ? 'undone' : 'redone', back: e.return_to };
    });
    const to = back !== '/' ? back : (result.back || '/');
    res.redirect(`${to}${to.includes('?') ? '&' : '?'}msg=${result.msg}`);
  }
  r.post('/undo', (req, res) => act(req, res, 'undo'));
  r.post('/redo', (req, res) => act(req, res, 'redo'));
}

module.exports = { mountUndo };
