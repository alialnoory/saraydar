'use strict';
// Every email goes into outbox_messages first. It is only marked "sent" when the SMTP server accepts it.
// Without SMTP settings it is stored as "unconfigured" and stays visible to the Super Admin.
const nodemailer = require('nodemailer');

function smtpConfig(env = process.env) {
  if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASS) return null;
  const port = parseInt(env.SMTP_PORT, 10) || 587;
  return {
    host: env.SMTP_HOST, port, secure: port === 465, requireTLS: port !== 465,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    from: env.MAIL_FROM || env.SMTP_USER
  };
}

function createMailer({ pool, env = process.env, transport } = {}) {
  const cfg = smtpConfig(env);
  const tx = transport || (cfg ? nodemailer.createTransport({ host: cfg.host, port: cfg.port, secure: cfg.secure, requireTLS: cfg.requireTLS, auth: cfg.auth }) : null);

  async function send({ to, subject, text, kind, sensitive = false, workspaceId = null }) {
    const status = tx ? 'queued' : 'unconfigured';
    const { rows } = await pool.query(
      `insert into outbox_messages (to_address, subject, body_text, kind, sensitive, status, workspace_id)
       values ($1,$2,$3,$4,$5,$6,$7) returning id`,
      [to, subject, text, kind, sensitive, status, workspaceId]);
    const id = rows[0].id;
    if (!tx) return { id, status };
    try {
      const info = await tx.sendMail({ from: cfg ? cfg.from : env.MAIL_FROM, to, subject, text });
      await pool.query(
        `update outbox_messages set status = 'sent', attempts = attempts + 1, provider_id = $2, sent_at = now(),
                body_text = case when sensitive then null else body_text end where id = $1`,
        [id, String(info.messageId || '')]);
      return { id, status: 'sent' };
    } catch (e) {
      await pool.query("update outbox_messages set status = 'failed', attempts = attempts + 1, error = $2 where id = $1", [id, String(e.message).slice(0, 500)]);
      return { id, status: 'failed' };
    }
  }

  return { send, configured: !!tx, describe: () => cfg ? `${cfg.host}:${cfg.port} as ${cfg.auth.user}` : 'Not configured' };
}

module.exports = { createMailer, smtpConfig };
