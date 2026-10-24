'use strict';
// Every email goes into outbox_messages first. It is only marked "sent" when the provider accepts it.
// Without settings it is stored as "unconfigured" and stays visible to the Super Admin.
//
// Two providers:
//  1. Microsoft 365 through Microsoft Graph (recommended): MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET, MAIL_FROM.
//     An Entra app registration with the Mail.Send application permission sends as the MAIL_FROM mailbox.
//     Microsoft is switching off password-based SMTP for apps (end of December 2026), so this is the lasting route.
//  2. SMTP with a password: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM.
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

function graphConfig(env = process.env) {
  if (!env.MS_TENANT_ID || !env.MS_CLIENT_ID || !env.MS_CLIENT_SECRET || !env.MAIL_FROM) return null;
  const m = /<([^>]+)>/.exec(env.MAIL_FROM);
  const address = (m ? m[1] : env.MAIL_FROM).trim();
  const name = m ? env.MAIL_FROM.slice(0, m.index).trim().replace(/^"|"$/g, '') : '';
  return { tenant: env.MS_TENANT_ID.trim(), clientId: env.MS_CLIENT_ID.trim(), secret: env.MS_CLIENT_SECRET.trim(), address, name,
    loginBase: (env.MS_LOGIN_URL || 'https://login.microsoftonline.com').replace(/\/$/, ''), graphBase: (env.MS_GRAPH_URL || 'https://graph.microsoft.com').replace(/\/$/, '') };
}

// A small transport with the same sendMail() shape as nodemailer's.
function graphTransport(g) {
  let token = null, expires = 0;
  async function getToken() {
    if (token && Date.now() < expires - 60000) return token;
    const res = await fetch(`${g.loginBase}/${encodeURIComponent(g.tenant)}/oauth2/v2.0/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: g.clientId, client_secret: g.secret, scope: `${g.graphBase}/.default`, grant_type: 'client_credentials' }),
      signal: AbortSignal.timeout(20000)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) throw new Error(`Microsoft sign-in failed (${res.status}${data.error ? `: ${data.error}` : ''}). Check the tenant ID, client ID and client secret.`);
    token = data.access_token; expires = Date.now() + (Number(data.expires_in) || 3600) * 1000;
    return token;
  }
  const recipients = to => String(to).split(',').map(s => s.trim()).filter(Boolean).map(a => ({ emailAddress: { address: a } }));
  return {
    async sendMail({ to, subject, text, attachments }) {
      const t = await getToken();
      const message = {
        subject, body: { contentType: 'Text', content: text || '' }, toRecipients: recipients(to),
        from: { emailAddress: { address: g.address, ...(g.name ? { name: g.name } : {}) } },
        ...(attachments && attachments.length ? { attachments: attachments.map(a => ({ '@odata.type': '#microsoft.graph.fileAttachment', name: a.filename, contentType: a.contentType || 'application/octet-stream', contentBytes: Buffer.from(a.content).toString('base64') })) } : {})
      };
      const res = await fetch(`${g.graphBase}/v1.0/users/${encodeURIComponent(g.address)}/sendMail`, {
        method: 'POST', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
        body: JSON.stringify({ message, saveToSentItems: true }), signal: AbortSignal.timeout(30000)
      });
      if (res.status !== 202) {
        const data = await res.json().catch(() => ({}));
        const code = data.error && data.error.code ? `: ${data.error.code}` : '';
        if (res.status === 401 || res.status === 403) token = null;
        throw new Error(`Microsoft 365 refused the message (${res.status}${code}).${res.status === 403 ? ' Check that Mail.Send (Application) has admin consent and the app may send as this mailbox.' : ''}`);
      }
      return { messageId: res.headers.get('request-id') || 'graph-accepted' };
    }
  };
}

function createMailer({ pool, env = process.env, transport } = {}) {
  const g = graphConfig(env);
  const cfg = g ? null : smtpConfig(env);
  const tx = transport || (g ? graphTransport(g) : cfg ? nodemailer.createTransport({ host: cfg.host, port: cfg.port, secure: cfg.secure, requireTLS: cfg.requireTLS, auth: cfg.auth }) : null);
  const from = g ? g.address : cfg ? cfg.from : env.MAIL_FROM;

  async function send({ to, subject, text, kind, sensitive = false, workspaceId = null, attachments = null, refKind = null, refId = null }) {
    const status = tx ? 'queued' : 'unconfigured';
    const { rows } = await pool.query(
      `insert into outbox_messages (to_address, subject, body_text, kind, sensitive, status, workspace_id, ref_kind, ref_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
      [to, subject, text, kind, sensitive, status, workspaceId, refKind, refId]);
    const id = rows[0].id;
    if (!tx) return { id, status };
    try {
      const info = await tx.sendMail({ from, to, subject, text, ...(attachments ? { attachments } : {}) });
      await pool.query(
        `update outbox_messages set status = 'sent', attempts = attempts + 1, provider_id = $2, sent_at = now(),
                body_text = case when sensitive then null else body_text end where id = $1`,
        [id, String(info.messageId || '')]);
      return { id, status: 'sent' };
    } catch (e) {
      await pool.query("update outbox_messages set status = 'failed', attempts = attempts + 1, error = $2 where id = $1", [id, String(e.message).slice(0, 500)]);
      return { id, status: 'failed', error: String(e.message) };
    }
  }

  const describe = () => g ? `Microsoft 365 (Graph) as ${g.address}` : cfg ? `SMTP ${cfg.host}:${cfg.port} as ${cfg.auth.user}` : 'Not configured';
  return { send, configured: !!tx, describe, provider: g ? 'graph' : cfg ? 'smtp' : null };
}

module.exports = { createMailer, smtpConfig, graphConfig };
