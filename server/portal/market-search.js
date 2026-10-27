'use strict';
// "Search the market" for acquisition requests (owner request): the AI searches public property websites for listings
// that fit the buyer's brief and returns them with their links. Staff review each one and may add it as an external
// opportunity, which then goes through the normal shortlist checks. Only the search criteria are sent to the AI
// provider: never the client's name, contact details, notes or anything else from the record. Nothing is shortlisted,
// published or sent to the client automatically.
const { html, raw, csrfField, fmtDateTime, pill } = require('./views');
const { formatMoney } = require('../lib/money');

const PER_DAY = 10;             // searches per request per day
const MAX_RESULTS = 12;
const fm = m => m === null || m === undefined ? '—' : formatMoney(Number(m));
const n = v => v === null || v === undefined || v === '' ? null : Number(v);

function aiConfig(env) {
  if (!env.ANTHROPIC_API_KEY) return null;
  return { key: env.ANTHROPIC_API_KEY, model: env.AI_SEARCH_MODEL || env.AI_MODEL || 'claude-sonnet-5-5', url: (env.AI_API_URL || 'https://api.anthropic.com').replace(/\/$/, '') + '/v1/messages' };
}

// The criteria in plain words, from the brief. This text is exactly what the AI receives about the client's needs.
function criteriaOf(b) {
  const L = [];
  const range = (lo, hi, unit) => lo != null && hi != null ? `${lo} to ${hi}${unit}` : lo != null ? `at least ${lo}${unit}` : hi != null ? `up to ${hi}${unit}` : null;
  if (b.purpose) L.push(`Purpose: ${b.purpose}`);
  if (b.types) L.push(`Property types: ${b.types}`);
  if (b.locations) L.push(`Preferred locations in Bahrain: ${b.locations}`);
  const bud = range(b.budget_min_minor != null ? formatMoney(Number(b.budget_min_minor), b.currency || 'BHD') : null, b.budget_max_minor != null ? formatMoney(Number(b.budget_max_minor), b.currency || 'BHD') : null, '');
  if (bud) L.push(`Budget: ${bud}${b.flexibility_pct != null ? ` (flexible by about ${Number(b.flexibility_pct)}%)` : ''}`);
  const land = range(n(b.land_min_m2), n(b.land_max_m2), ' m²'); if (land) L.push(`Land area: ${land}`);
  const built = range(n(b.built_min_m2), n(b.built_max_m2), ' m²'); if (built) L.push(`Built-up area: ${built}`);
  if (b.bedrooms_min != null) L.push(`Bedrooms: at least ${b.bedrooms_min}`);
  if (b.features) L.push(`Wanted features: ${b.features}`);
  if (b.condition) L.push(`Condition: ${b.condition}`);
  if (b.exclusions) L.push(`Exclude: ${b.exclusions}`);
  return L.join('\n');
}

const SYSTEM = 'You are a property researcher for SarayDar Real Estate in the Kingdom of Bahrain. Use web search to find property listings '
  + 'currently advertised for sale in Bahrain on public websites (property portals, agency sites, classifieds) that fit the criteria. '
  + 'Report only listings you actually found in search results, each with the exact URL of the listing page. Never invent a listing, '
  + 'price, size or link; if a detail is not stated on the listing, leave it null. Prices in Bahraini dinars. Prefer recent listings. '
  + 'It is fine to return fewer results, or none, when nothing suitable is found.';

const FORMAT = `When you have finished searching, reply with only a JSON array (at most ${MAX_RESULTS} items) between <results> and </results>. `
  + 'Each item: {"title": string, "url": string, "source": website name, "location": string|null, "property_type": string|null, '
  + '"price_bhd": number|null, "bedrooms": number|null, "land_area_m2": number|null, "built_area_m2": number|null, '
  + '"listed": string|null (date or age shown on the listing), "fit": one short sentence on how it fits or does not fit the criteria}.';

function parseResults(text) {
  const m = /<results>([\s\S]*?)<\/results>/.exec(text || '') || /(\[[\s\S]*\])/.exec(text || '');
  if (!m) throw new Error('The AI reply had no results list.');
  let arr; try { arr = JSON.parse(m[1].trim()); } catch { throw new Error('The AI reply could not be read.'); }
  if (!Array.isArray(arr)) throw new Error('The AI reply could not be read.');
  const seen = new Set(), out = [];
  const s = (v, max) => typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
  const num = v => { const x = typeof v === 'string' ? Number(v.replace(/[,\s]/g, '')) : v; return Number.isFinite(x) && x > 0 ? x : null; };
  for (const r of arr) {
    if (!r || typeof r !== 'object') continue;
    let url; try { url = new URL(String(r.url || '')); } catch { continue; }
    if (!/^https?:$/.test(url.protocol) || seen.has(url.href)) continue;
    seen.add(url.href);
    out.push({ title: s(r.title, 200) || url.hostname, url: url.href, source: s(r.source, 80) || url.hostname.replace(/^www\./, ''), location: s(r.location, 120),
      property_type: s(r.property_type, 60), price_bhd: num(r.price_bhd), bedrooms: num(r.bedrooms) && Math.round(num(r.bedrooms)), land_area_m2: num(r.land_area_m2),
      built_area_m2: num(r.built_area_m2), listed: s(r.listed, 60), fit: s(r.fit, 300) });
    if (out.length >= MAX_RESULTS) break;
  }
  return out;
}

function mountMarketSearch(r, ctx) {
  const { pool, core, env } = ctx;
  const cfg = () => aiConfig(env);

  async function callAi(criteria) {
    const c = cfg();
    const messages = [{ role: 'user', content: `Search criteria from the buyer's brief:\n${criteria}\n\n${FORMAT}` }];
    const tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 10, user_location: { type: 'approximate', country: 'BH', timezone: 'Asia/Bahrain' } }];
    for (let turn = 0; turn < 4; turn++) {
      const res = await fetch(c.url, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': c.key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: c.model, max_tokens: 6000, system: SYSTEM, tools, messages }), signal: AbortSignal.timeout(240000)
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`The AI provider returned an error (${res.status}${data.error && data.error.type ? `: ${data.error.type}` : ''}).`);
      if (data.stop_reason === 'pause_turn') { messages.push({ role: 'assistant', content: data.content }); continue; }   // long search: let it carry on
      return parseResults((data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n'));
    }
    throw new Error('The search took too long. Try again.');
  }

  async function run(id, criteria) {
    try {
      const results = await callAi(criteria);
      await pool.query("update market_searches set status = 'done', results = $2, finished_at = now() where id = $1", [id, JSON.stringify(results)]);
    } catch (e) {
      await pool.query("update market_searches set status = 'failed', error = $2, finished_at = now() where id = $1", [id, String(e.message || e).slice(0, 300)]).catch(() => {});
    }
  }
  ctx.marketSearchRun = run;   // tests wait on it

  r.post('/w/:id/market-search', async (req, res) => {
    const a = await ctx.SL.access(req);
    if (a.ws.kind !== 'request' || !a.internal) throw new ctx.NotFound();
    if (!core.canContribute(a)) throw new ctx.Forbidden();
    const back = `/w/${a.ws.id}/shortlist#market`;
    if (!cfg()) return res.redirect(back);
    const b = await ctx.SL.briefOf(a.ws.id);
    if (!b) throw Object.assign(new Error('Record the brief first: the search uses it.'), { status: 400 });
    const busy = (await pool.query("select count(*)::int as n from market_searches where workspace_id = $1 and status = 'running' and created_at > now() - interval '10 minutes'", [a.ws.id])).rows[0].n;
    if (busy) return res.redirect(back);
    const today = (await pool.query("select count(*)::int as n from market_searches where workspace_id = $1 and created_at > now() - interval '1 day'", [a.ws.id])).rows[0].n;
    if (today >= PER_DAY) throw Object.assign(new Error(`This request has had ${PER_DAY} market searches in the last 24 hours. Try again later.`), { status: 429 });
    const criteria = criteriaOf(b);
    if (!criteria) throw Object.assign(new Error('The brief has no criteria to search with yet.'), { status: 400 });
    const id = (await pool.query('insert into market_searches (workspace_id, brief_version, criteria, created_by) values ($1,$2,$3,$4) returning id', [a.ws.id, b.version, criteria, req.user.id])).rows[0].id;
    await core.audit(pool, { actor: req.user, workspaceId: a.ws.id, action: 'request.market_searched', entity: 'market_search', entityId: id, summary: 'AI market search started (search criteria only were sent)' });
    ctx.lastMarketSearch = run(id, criteria);     // runs in the background; the page refreshes until it finishes
    res.redirect(back);
  });

  // add one found listing as an external opportunity (unverified; the shortlist rules still apply)
  r.post('/w/:id/market-search/:sid/add', async (req, res) => {
    const a = await ctx.SL.access(req);
    if (a.ws.kind !== 'request' || !a.internal) throw new ctx.NotFound();
    if (!core.canContribute(a)) throw new ctx.Forbidden();
    const s = (await pool.query('select * from market_searches where id = $1 and workspace_id = $2', [/^[0-9a-f-]{36}$/i.test(req.params.sid) ? req.params.sid : null, a.ws.id])).rows[0];
    const x = s && s.results[Number(req.body.n)];
    if (!x) throw new ctx.NotFound();
    const dup = (await pool.query('select id from external_opps where workspace_id = $1 and notes like $2 limit 1', [a.ws.id, `%${x.url}%`])).rows[0];
    if (!dup) await core.inTx(async db => {
      const id = (await db.query(`insert into external_opps (workspace_id, title, source, property_type, location, price_minor, land_area_m2, built_area_m2, bedrooms, verification, availability, notes, created_by)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'unverified','unknown',$10,$11) returning id`,
        [a.ws.id, x.title, x.source, x.property_type, x.location, x.price_bhd != null ? Math.round(x.price_bhd * 1000) : null, x.land_area_m2, x.built_area_m2, x.bedrooms,
          `Found by AI market search on ${new Date().toISOString().slice(0, 10)}: ${x.url}${x.listed ? `\nListed: ${x.listed}` : ''}\nNot verified: confirm the details and availability with the advertiser.`, req.user.id])).rows[0].id;
      await core.audit(db, { actor: req.user, workspaceId: a.ws.id, action: 'request.external_recorded', entity: 'external_opp', entityId: id, summary: `External opportunity recorded from market search: ${x.title} (${x.source})` });
    });
    res.redirect(`/w/${a.ws.id}/shortlist?msg=saved#market`);
  });

  // the panel on Matches & Shortlist
  ctx.marketPanel = async (req, a, brief) => {
    if (a.ws.kind !== 'request' || !a.internal) return '';
    const edit = core.canContribute(a);
    const last = (await pool.query('select * from market_searches where workspace_id = $1 order by created_at desc limit 1', [a.ws.id])).rows[0];
    const ext = (await pool.query('select notes from external_opps where workspace_id = $1', [a.ws.id])).rows.map(x => x.notes || '').join('\n');
    const running = last && last.status === 'running' && Date.now() - new Date(last.created_at).getTime() < 10 * 60000;
    const button = edit && cfg() && brief && !running ? html`<form method="post" action="/w/${a.ws.id}/market-search" class="actions">${csrfField(req)}
      <button class="btn primary" type="submit">${last ? 'Search again' : 'Search the market'}</button></form>` : '';
    let body;
    if (!cfg()) body = html`<p class="muted">Not configured: the AI key has not been added on the server. ${core.isSuper(req.user) ? 'Add ANTHROPIC_API_KEY to the server settings to turn it on.' : 'Ask the Super Admin.'}</p>`;
    else if (!brief) body = html`<p class="muted">Record the brief first: the search uses it. <a href="/w/${a.ws.id}/brief">Open the brief</a></p>`;
    else if (running) body = html`<div class="ms-wait" data-autorefresh="6"><span class="ms-spin" aria-hidden="true"></span><div><b>Searching property websites…</b><div class="muted small">This usually takes one to three minutes. The page refreshes by itself.</div></div></div>`;
    else if (!last) body = html`<p class="muted">Searches public property websites in Bahrain for listings that fit this brief, and lists what it finds with links. You decide what to add.</p>`;
    else if (last.status === 'failed') body = html`<p class="err">The last search did not finish: ${last.error || 'unknown error'}.</p>`;
    else if (!last.results.length) body = html`<p class="muted">The last search (${fmtDateTime(last.created_at)}) found no suitable listings.</p>`;
    else body = html`<p class="muted small">${last.results.length} listing${last.results.length === 1 ? '' : 's'} found ${fmtDateTime(last.created_at)}. From public websites and not verified: open each link and confirm with the advertiser before proposing it to the client.</p>
      <ul class="ms-list">${last.results.map((x, i) => html`<li class="ms-item">
        <div class="ms-main"><a class="ms-title" href="${x.url}" target="_blank" rel="noopener noreferrer nofollow">${x.title} ↗</a>
          <div class="muted small">${[x.source, x.location, x.property_type, x.listed ? `listed ${x.listed}` : null].filter(Boolean).join(' · ')}</div>
          <div class="ms-facts">${x.price_bhd != null ? html`<span><b>${fm(Math.round(x.price_bhd * 1000))}</b></span>` : html`<span class="muted">Price not stated</span>`}
            ${x.bedrooms ? html`<span>${x.bedrooms} bed</span>` : ''}${x.built_area_m2 ? html`<span>${Math.round(x.built_area_m2)} m² built</span>` : ''}${x.land_area_m2 ? html`<span>${Math.round(x.land_area_m2)} m² land</span>` : ''}</div>
          ${x.fit ? html`<div class="small ms-fit">${x.fit}</div>` : ''}</div>
        <div class="ms-act">${ext.includes(x.url) ? pill('Added', 'ok') : edit ? html`<form method="post" action="/w/${a.ws.id}/market-search/${last.id}/add">${csrfField(req)}<input type="hidden" name="n" value="${i}"><button class="btn small" type="submit">Add as opportunity</button></form>` : ''}</div>
      </li>`)}</ul>`;
    return html`<section class="panel ms" id="market"><div class="row-between"><h2 class="h">Search the market ${pill('AI', 'info')}</h2>${button}</div>
      ${body}
      ${cfg() && brief ? html`<details class="small muted"><summary>What is sent to the AI</summary><p>Only these search criteria from the brief. The client's name, contact details and notes are never sent.</p><pre class="ms-criteria">${(last && last.criteria) || criteriaOf(brief)}</pre></details>` : ''}
    </section>`;
  };
}

module.exports = { mountMarketSearch, criteriaOf, parseResults };
