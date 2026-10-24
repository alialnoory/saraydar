'use strict';
// In-portal help (owner request 2026-10-24): a short tip with an example at the top of every tab, and a Help
// page built from the same text, so the tips, the Help page and the user manual say the same thing.
const { layout, html } = require('./views');

// [what the tab is for, a worked example]
const COMMON = {
  Overview: ['The record at a glance. Start with "What\'s missing": each "Do it ›" opens the place where that item is entered.', 'Click "Do it ›" beside "Client telephone or email" to open the client\'s details.'],
  Setup: ['Answer the guided questions once. The system then prepares the draft plan: phases, tasks, risks, approvals and budget lines.', 'Choose "Construction" as the current stage: earlier phases are marked done and later ones not started.'],
  'Land & Plots': ['Record each plot with its number, title deed, area, dimensions and documents.', 'Plot 05-1234, title deed 123456/2024, 600 m², frontage 20 m, status Owned.'],
  Plan: ['Check the draft plan and approve it as the baseline. Progress is measured against the approved plan.', 'After checking phases and weights, click "Approve plan". Later changes become a new version.'],
  'Tasks & Schedule': ['Phases, tasks, owners, dates and milestones. Update the status as work moves.', 'Task "Superstructure", owner DEMO Building Contractors, due 30 Jun 2027, 60% done.'],
  'Progress Updates': ['Site progress reports with photos. Publish an update to share it with the client.', '"October 2026: first-floor slab cast", 6 photos, overall progress 45%.'],
  Registers: ['One list each for risks, issues, decisions, permits, stakeholders and more.', 'Risk "Material price increases": likelihood Medium, impact High, owner the project manager.'],
  Agreements: ['Every agreement for this record: generate from a template, issue, record the signing and upload the signed copy.', 'After the client signs, open the agreement, choose "Record signed" and upload the scanned PDF.'],
  Documents: ['Drawings, contracts, permits and photos. Choose who can see each file.', 'Upload "Building permit.pdf", caption "Building permit BP-2026-1123", visible to SarayDar staff only.'],
  Reports: ['Download a branded PDF or Excel report for any period.', 'Period 1–31 Oct 2026, tick "Include photos", then PDF: ready to send to the client.'],
  'Access & Invitations': ['Who can see this record. Invite clients, owners or investors as view-only users.', 'Invite Mr. Yusuf as Client Viewer, with "their own statement, invoices and receipts" ticked.'],
  Assistant: ['Ask questions about this record in plain English. Answers use only this record\'s data.', '"What is overdue this week, and who owns it?"'],
  Activity: ['Every change: who made it and when. Nothing here can be edited.', 'See who changed the monthly fee, with the old and new amounts.'],
  Expenses: ['Costs for this record and who bears them.', 'Photography BHD 80, SarayDar cost.']
};

const BY_KIND = {
  client_project: {
    Client: ['Who the client is, and who signs and approves for them: their representative, or tick that the client signs personally. Entered once; the agreement and approvals use it.', 'Sara Alsamaheeji, CPR 961204761, WhatsApp; represented by Mahdi Almaskati under power of attorney.'],
    Agreements: ['The management terms (fee, period, scope), the agreement generated from them, and any other contracts. Record the terms at the top; Finance activates them; then generate the agreement.', 'Fee BHD 1,500 a month from 1 Oct 2026, billed in advance, payment due 30 days after the invoice.'],
    'Client Budget & Payments': ['The client\'s own construction budget, contracts, invoices and payments: never SarayDar money. SarayDar\'s fees go under Fee Billing.', 'Contract with DEMO Building Contractors for BHD 120,000; payment application no. 3 for BHD 18,000.'],
    'Fee Billing': ['SarayDar\'s monthly management-fee invoices to the client, and the client\'s payments to SarayDar.', 'Issue the November 2026 invoice for BHD 1,500; record the bank transfer when it arrives.'],
    'Client Approvals': ['What the client must approve, and their approval recorded with its evidence.', '"Kitchen marble sample" requested from Mrs. Huda on 20 Oct; approved by WhatsApp on 22 Oct.']
  },
  project: {
    'Budget & Cost': ['SarayDar\'s development budget, contracts, supplier invoices and payments.', 'Line "Construction" BHD 180,000; main contract signed; contractor invoice no. 12 approved.'],
    'Investors & Funding': ['Each investor\'s agreed contribution, money received and profit-sharing terms, as signed.', 'DEMO Holdings: equity, BHD 100,000 agreed, BHD 50,000 received.'],
    'Units & Sales': ['The units being built, their plots, list prices and sales status.', 'Villa 3 on plot 551, 320 m², list price BHD 165,000, Reserved.']
  },
  property: {
    Owner: ['Who the owner is and how to reach them. Entered once; the agreement and owner statements use it.', 'Owner Mrs. Fatima Ahmed, +973 3600 0000, prefers email.'],
    Agreements: ['The management terms, the agreement generated from them, and the leases and other contracts for this property.', 'Management fee BHD 400 a month from 1 Nov 2026; rent collected by SarayDar.'],
    'Property Setup': ['How this property is run: who collects the rent, spending limits and owner approvals.', 'Repairs up to BHD 150 may be done without asking the owner.'],
    Units: ['Every flat, shop or office in the property, with its status.', 'Flat 12: 2 bedrooms, 110 m², Occupied.'],
    'Leases & Tenants': ['Tenants and their leases: rent, dates, deposit and renewal.', 'Ahmed Ali, flat 12, BHD 450 a month, 1 Nov 2026 – 31 Oct 2027.'],
    'Rent & Collections': ['Rent invoices and payments received. Overdue rent shows here.', 'Cheque 000123 for BHD 450 received on 1 Nov for flat 12.'],
    Deposits: ['Security deposits received, held and returned.', 'BHD 450 deposit from Ahmed Ali; returned less BHD 50 for cleaning at move-out.'],
    Maintenance: ['Repair requests from report to completion, with cost and photos.', '"AC not cooling, flat 12": assigned to the AC contractor, BHD 35, done 3 Nov.'],
    'Cleaning & Services': ['Regular cleaning and service visits, with checklists.', 'Common-area cleaning every Saturday, BHD 60 a visit.'],
    Expenses: ['Costs paid for this property, and who bears them.', 'Water pump repair BHD 120, charged to the owner.'],
    'Owner Account': ['The owner\'s statement: rent in, expenses and fees out, and the balance paid to the owner.', 'October: rent BHD 3,600, expenses BHD 240, fee BHD 400, paid to the owner BHD 2,960.'],
    'Fee Billing': ['SarayDar\'s management-fee invoices to the owner, and the payments received.', 'November 2026 management fee BHD 400, deducted from the rent collected.'],
    'Unit History': ['Everything that happened to one unit: tenants, rent and repairs.', 'Open flat 12 to see every tenant since 2024 and every repair.']
  },
  listing: {
    Mandate: ['The seller\'s authority for SarayDar to market the property: period, price authority and fee.', 'Exclusive, 1 Oct – 31 Dec 2026, 2% commission on completion, paid by the seller.'],
    'Property File': ['The facts about the property, the asking price and the approved photos.', 'Villa on 450 m² of land, 5 bedrooms, asking BHD 285,000, 12 approved photos.'],
    Marketing: ['Where the property is advertised, and what it costs.', 'Property portal listing, reference PF-88231, BHD 25.'],
    'Buyers & Viewings': ['Interested buyers, their enquiries and viewings of this property.', 'Viewing with DEMO Buyer on Sat 2 Nov at 10:00, meeting at the gate.'],
    'Offers & Deal': ['Offers, counter-offers and the deal through to completion.', 'Offer BHD 270,000 from DEMO Buyer; the seller countered at BHD 278,000.'],
    'Fee Billing': ['SarayDar\'s commission invoice and the payment received.', '2% commission on BHD 278,000 = BHD 5,560.']
  },
  request: {
    Mandate: ['The buyer\'s authority for SarayDar to search on their behalf, and the fee.', 'Non-exclusive for 3 months; fixed fee BHD 1,000 on purchase.'],
    Brief: ['What the buyer is looking for.', 'Villa in Saar or Janabiya, 4+ bedrooms, BHD 200,000–260,000, needed by summer 2027.'],
    'Matches & Shortlist': ['Properties that fit the brief. Shortlist the best ones to show the buyer.', 'Shortlist Amwaj Villa 7: 5 bedrooms, BHD 285,000 (above budget, negotiable).'],
    'Viewings & Offers': ['Viewings arranged for the buyer, and offers made.', 'Viewing of Amwaj Villa 7 on 2 Nov; offer of BHD 270,000 made on 4 Nov.'],
    'Fee Billing': ['SarayDar\'s fee invoice to the buyer, and the payment received.', 'Fixed search fee BHD 1,000, invoiced on purchase.']
  }
};

const tipFor = (kind, label) => (BY_KIND[kind] && BY_KIND[kind][label]) || COMMON[label] || null;

function tabTip(req, label) {
  if (!req.user || req.user.kind === 'external' || !label || !req.wsKind) return '';
  const t = tipFor(req.wsKind, label);
  if (!t) return '';
  return html`<aside class="tabtip no-export" data-tabtip><div class="grow"><b>${label}:</b> ${t[0]} <span class="tabtip-ex"><b>Example:</b> ${t[1]}</span></div>
    <div class="tabtip-act"><a href="/help#${req.wsKind || 'start'}">Help</a><button type="button" class="linkbtn" data-hide-tips>Hide tips</button></div></aside>`;
}

const KIND_TITLE = { client_project: 'Clients Projects Management', project: 'SarayDar Real Estate Development', property: 'Clients Properties Management', listing: 'Property Sales: selling a property', request: 'Property Acquisition: searching for a buyer' };
const TAB_ORDER = {
  client_project: ['Overview', 'Client', 'Agreements', 'Setup', 'Land & Plots', 'Plan', 'Tasks & Schedule', 'Client Budget & Payments', 'Fee Billing', 'Client Approvals', 'Progress Updates', 'Registers', 'Documents', 'Reports', 'Access & Invitations', 'Assistant', 'Activity'],
  project: ['Overview', 'Setup', 'Land & Plots', 'Plan', 'Tasks & Schedule', 'Budget & Cost', 'Investors & Funding', 'Progress Updates', 'Registers', 'Units & Sales', 'Agreements', 'Documents', 'Reports', 'Access & Invitations', 'Assistant', 'Activity'],
  property: ['Overview', 'Owner', 'Agreements', 'Property Setup', 'Units', 'Leases & Tenants', 'Rent & Collections', 'Deposits', 'Maintenance', 'Cleaning & Services', 'Expenses', 'Owner Account', 'Fee Billing', 'Unit History', 'Reports', 'Documents', 'Access & Invitations', 'Assistant', 'Activity'],
  listing: ['Overview', 'Mandate', 'Property File', 'Marketing', 'Buyers & Viewings', 'Offers & Deal', 'Fee Billing', 'Expenses', 'Agreements', 'Documents', 'Access & Invitations', 'Assistant', 'Activity'],
  request: ['Overview', 'Mandate', 'Brief', 'Matches & Shortlist', 'Viewings & Offers', 'Fee Billing', 'Expenses', 'Agreements', 'Documents', 'Access & Invitations', 'Assistant', 'Activity']
};
// the usual order of work for a new record
const FIRST_STEPS = {
  client_project: ['Create the project: Clients Projects Management › + Create New Client Project (name, client, location, manager).', 'Client: complete the client\'s details, then their representative (or tick that the client signs personally).', 'Agreements: record the management terms; Finance activates them; click "Generate the agreement" and send it for signing; then "Record signed agreement" to upload the signed copy.', 'Setup: answer the guided questions, then "Generate draft plan".', 'Plan: check phases and weights, then "Approve plan and save baseline".', 'Client Budget & Payments: enter the budget amounts, contracts, invoices and payments as they happen.', 'Every month: a progress update with photos, and the fee invoice under Fee Billing.'],
  project: ['Create the project: SarayDar Real Estate Development › + Create.', 'Land & Plots: record each plot with its title deed and area.', 'Setup: answer the guided questions, then "Generate draft plan".', 'Plan: check it, then "Approve plan and save baseline".', 'Budget & Cost: enter budget amounts; record contracts, invoices and payments.', 'Investors & Funding and Units & Sales as they apply.', 'Every month: a progress update with photos.'],
  property: ['Create the property under Clients Properties Management.', 'Owner: link the owner and complete their details.', 'Agreements: record the management terms and generate the agreement.', 'Property Setup: rent collection and spending limits.', 'Units: add every unit.', 'Leases & Tenants: add each tenant and lease; rent invoices follow.', 'Every month: record rent received, maintenance and expenses; issue the owner statement.'],
  listing: ['Create the listing under Property Sales & Acquisition (seller name).', 'Mandate: record the seller\'s authority, period and fee; verify the authority.', 'Property File: facts, asking price, description and approved photos.', 'Marketing, then Buyers & Viewings and Offers & Deal as they happen.'],
  request: ['Create the request under Property Sales & Acquisition (buyer name).', 'Mandate: record the buyer\'s authority and fee.', 'Brief: what the buyer wants.', 'Matches & Shortlist, then Viewings & Offers.']
};

function mountHelp(r) {
  r.get('/help', (req, res) => {
    const kinds = Object.keys(TAB_ORDER);
    res.send(layout(req, { title: 'Help', heading: 'Help & user guide', crumbs: [['Home', '/'], ['Help']], body: html`
      <section class="panel" id="start"><h2 class="h">Getting started</h2>
        <ul class="help-list">
          <li><b>Home</b> shows the four sections as cards. Click a card to open its list, then click a project, property, listing or request to open it.</li>
          <li><b>Overview</b> opens first. Its <b>What's missing</b> checklist shows what still needs recording; <b>Do it ›</b> takes you to the right place.</li>
          <li><b>Tabs</b> across the top hold everything else. Each tab starts with a short tip and an example (<button type="button" class="linkbtn" data-show-tips>show tips again</button> if you hid them).</li>
          <li><b>Back</b>, <b>Home</b>, <b>Undo</b> and <b>Redo</b> are at the top right of every page. Undo reverses your last saved change if nobody has changed that record since.</li>
          <li><b>PDF</b> and <b>Excel</b> save the page you are looking at as a branded file.</li>
          <li><b>Search</b> at the top finds projects, properties, clients and references from any page.</li>
          <li>Pick from <b>dropdowns</b> and <b>tick-boxes</b> where offered; suggestions appear as you type. Tick <b>Not yet determined</b> rather than leaving something blank.</li>
        </ul>
        <p class="muted small">Jump to: ${kinds.map((k, i) => html`${i ? ' · ' : ''}<a href="#${k}">${KIND_TITLE[k]}</a>`)}</p></section>
      ${kinds.map(k => html`<section class="panel" id="${k}"><h2 class="h">${KIND_TITLE[k]}</h2>
        <h3 class="h3">Order of work for a new record</h3><ol class="help-list">${FIRST_STEPS[k].map(s => html`<li>${s}</li>`)}</ol>
        <h3 class="h3">The tabs</h3><div class="table-wrap"><table class="help-table"><thead><tr><th>Tab</th><th>What it is for</th><th>Example</th></tr></thead><tbody>
          ${TAB_ORDER[k].map(l => { const t = tipFor(k, l); return t ? html`<tr><td><b>${l}</b></td><td>${t[0]}</td><td class="muted">${t[1]}</td></tr>` : ''; })}</tbody></table></div></section>`)}
      <section class="panel" id="faq"><h2 class="h">Common questions</h2><dl class="details">
        <div><dt>I saved something by mistake</dt><dd>Click Undo at the top right straight away. If someone else has changed the record since, Undo stops and tells you.</dd></div>
        <div><dt>Where do the client's construction costs go, and where do SarayDar's fees go?</dt><dd>The client's costs go under Client Budget & Payments. SarayDar's own management fees go under Fee Billing. They never mix.</dd></div>
        <div><dt>How does a client see their project?</dt><dd>Access & Invitations › Invite an external viewer. They get a view-only login showing only what you allow.</dd></div>
        <div><dt>Something is unknown today</dt><dd>Tick "Not yet determined". It shows in What's missing and the setup review, so it is not forgotten.</dd></div>
        <div><dt>I cannot see a section or a button</dt><dd>Your role decides what you can see and change. Ask the administrator to adjust your role or add you to the project.</dd></div>
      </dl></section>` }));
  });
}

module.exports = { mountHelp, tabTip, tipFor, COMMON, BY_KIND, TAB_ORDER, FIRST_STEPS, KIND_TITLE };
