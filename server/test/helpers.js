'use strict';
// Shared test client with a cookie jar and form-token handling.
function client(base) {
  const jar = new Map();
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  async function req(method, path, { form, multipart, headers = {} } = {}) {
    const h = { cookie: cookie(), ...headers };
    let body;
    if (form) { body = new URLSearchParams(form).toString(); h['content-type'] = 'application/x-www-form-urlencoded'; }
    if (multipart) body = multipart;
    const res = await fetch(base + path, { method, headers: h, body, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';'); const i = kv.indexOf('=');
      const k = kv.slice(0, i), v = kv.slice(i + 1);
      if (v === '' || /expires=Thu, 01 Jan 1970/i.test(c)) jar.delete(k); else jar.set(k, v);
    }
    const ct = res.headers.get('content-type') || '';
    const text = ct.includes('text') || ct.includes('json') ? await res.text() : '';
    return { status: res.status, location: res.headers.get('location'), text, res };
  }
  const csrfFrom = t => (/name="_csrf" value="([^"]+)"/.exec(t) || [])[1];
  return {
    jar, get: p => req('GET', p),
    post: async (p, form = {}, page = null) => {
      let token = form._csrf;
      if (!token) { const g = await req('GET', page || p); token = csrfFrom(g.text); }
      return req('POST', p, { form: { ...form, _csrf: token } });
    },
    raw: req, csrfFrom
  };
}

module.exports = { client };
