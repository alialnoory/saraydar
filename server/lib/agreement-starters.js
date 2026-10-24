'use strict';
// Starter drafts. They are generic working drafts, NOT legal advice and NOT checked against any jurisdiction.
// Every generated document from a starter carries a review notice until the template is replaced or approved by the company.
// Format: "# " title, "## " clause heading, blank line = new paragraph, "- " bullet. Placeholders: {{key}}.

const COMMON = {
  agreement_date: { label: 'Agreement date', type: 'date', required: true, default: 'today' },
  governing_law: { label: 'Governing law', type: 'text', default: 'the Kingdom of Bahrain', hint: 'Confirm with your legal adviser.' },
  notices_days: { label: 'Notice period for termination (days)', type: 'number' }
};

const PARTIES = cp => `This Agreement is made on {{agreement_date}} (reference {{agreement.ref}}) between:

1. **{{company.legal_name}}**, commercial registration {{company.cr_number}}, of {{company.address}}, represented by {{company.signatory_name}}, {{company.signatory_title}} ("SarayDar"); and

2. **{{party.name}}**, ID / CR {{party.id_number}}, of {{party.address}}, telephone {{party.phone}}, email {{party.email}}{{party.represented_by}} (the "${cp}").`;

const SIGN = cp => `## Signatures

[[sign: For and on behalf of SarayDar | Name: {{company.signatory_name}} | Title: {{company.signatory_title}} | Company stamp]]
[[sign: For and on behalf of the ${cp} | Name: {{party.signatory}} | Title: ]]`;

const GENERAL = `## Governing law and disputes

This Agreement is governed by the laws of {{governing_law}}. The parties will first try to settle any dispute by good-faith discussion.

## Entire agreement

This Agreement, with its schedules, is the entire agreement between the parties on its subject and replaces earlier discussions. Changes are valid only in writing signed by both parties.`;

const STARTERS = [
  {
    key: 'subcontract', name: 'Subcontract Agreement', sections: ['dev', 'cpm'], category: 'Subcontract', counterparty: 'Subcontractor',
    fields: { ...COMMON, scope_of_works: { label: 'Scope of works', type: 'textarea', required: true }, contract_sum_amount: { label: 'Contract sum', type: 'money', required: true },
      start_date: { label: 'Start date', type: 'date', required: true }, completion_date: { label: 'Completion date', type: 'date', required: true },
      payment_terms: { label: 'Payment terms', type: 'textarea', hint: 'For example monthly progress payments certified by the project manager within 30 days.' },
      retention_pct: { label: 'Retention (%)', type: 'number' }, defects_period_months: { label: 'Defects liability period (months)', type: 'number' },
      delay_damages: { label: 'Delay damages (if agreed)', type: 'text' } },
    body: `# Subcontract Agreement

${PARTIES('Subcontractor')}

## Project

The works are for {{workspace.name}} ({{workspace.ref}}) at {{workspace.location}}.

## Scope of works

The Subcontractor will carry out the following works, including all labour, materials, equipment and supervision needed, in a good and workmanlike manner and in line with the drawings and specifications issued by SarayDar:

{{scope_of_works}}

## Programme

The Subcontractor will start on {{start_date}} and complete the works by {{completion_date}}, following the programme agreed with SarayDar. Delay damages: {{delay_damages}}.

## Contract sum and payment

The contract sum is {{contract_sum_amount}}. Payment terms: {{payment_terms}}

A retention of {{retention_pct}}% of each payment will be held and released after the defects liability period, subject to all defects being remedied.

## Variations

No variation is valid unless instructed in writing by SarayDar before the work is carried out. Agreed variations adjust the contract sum and programme as recorded in the instruction.

## Quality, safety and site rules

The Subcontractor will follow the site safety rules, applicable regulations and the instructions of SarayDar's site representative, and will keep the site clean and safe.

## Defects

The Subcontractor will remedy at its own cost any defect notified during {{defects_period_months}} months after completion.

## Insurance and liability

The Subcontractor is responsible for its personnel, equipment and the works until handover and will hold insurance acceptable to SarayDar.

## Termination

Either party may terminate for material breach not remedied within {{notices_days}} days of written notice. SarayDar will pay for work properly completed up to termination, less any amounts due to SarayDar.

${GENERAL}

${SIGN('Subcontractor')}`
  },
  {
    key: 'consultancy', name: 'Design Consultancy Agreement', sections: ['dev', 'cpm'], category: 'Consultancy', counterparty: 'Consultant',
    fields: { ...COMMON, services: { label: 'Services', type: 'textarea', required: true }, fee_amount: { label: 'Fee', type: 'money', required: true },
      fee_schedule: { label: 'Fee schedule', type: 'textarea', hint: 'For example by design stage.' }, deliverables: { label: 'Deliverables', type: 'textarea' }, programme: { label: 'Programme', type: 'textarea' } },
    body: `# Design Consultancy Agreement

${PARTIES('Consultant')}

## Project

{{workspace.name}} ({{workspace.ref}}) at {{workspace.location}}.

## Services

The Consultant will provide the following services with the skill and care expected of a qualified professional:

{{services}}

## Deliverables and programme

Deliverables: {{deliverables}}

Programme: {{programme}}

## Fee

The fee is {{fee_amount}}, payable as follows: {{fee_schedule}}. Additional services are paid only when agreed in writing beforehand.

## Ownership and use of designs

SarayDar may use the drawings and documents produced under this Agreement for the project once the related fees have been paid.

## Termination

Either party may terminate on {{notices_days}} days' written notice. Fees for services properly performed up to termination will be paid.

${GENERAL}

${SIGN('Consultant')}`
  },
  {
    key: 'unit_sale', name: 'Unit Sale and Purchase Agreement', sections: ['dev'], category: 'Sale', counterparty: 'Buyer',
    fields: { ...COMMON, unit_description: { label: 'Unit description', type: 'textarea', required: true }, price_amount: { label: 'Purchase price', type: 'money', required: true },
      payment_schedule: { label: 'Payment schedule', type: 'textarea', required: true }, handover_date: { label: 'Expected handover date', type: 'date' }, title_transfer: { label: 'Title transfer arrangements', type: 'textarea' } },
    body: `# Unit Sale and Purchase Agreement

${PARTIES('Buyer')}

## The unit

SarayDar agrees to sell and the Buyer agrees to buy the following unit in {{workspace.name}} at {{workspace.location}}:

{{unit_description}}

## Price and payment

The purchase price is {{price_amount}}, payable as follows:

{{payment_schedule}}

A payment is treated as received only when it has cleared into SarayDar's account.

## Handover

SarayDar expects to hand over the unit by {{handover_date}}. Handover takes place after the full price has been received and the completion inspection has been carried out.

## Title

{{title_transfer}}

## Default

If the Buyer does not pay an instalment within {{notices_days}} days of a written reminder, SarayDar may terminate this Agreement under the terms set out in the payment schedule.

${GENERAL}

${SIGN('Buyer')}`
  },
  {
    key: 'pm_services', name: 'Project Management Services Agreement', sections: ['cpm'], category: 'Management agreement', counterparty: 'Client',
    fields: { ...COMMON, services: { label: 'Management services', type: 'textarea', required: true }, exclusions: { label: 'Exclusions', type: 'textarea' },
      monthly_fee_amount: { label: 'Monthly management fee', type: 'money', required: true }, start_date: { label: 'Start date', type: 'date', required: true }, duration_months: { label: 'Duration (months)', type: 'number' },
      billing_timing: { label: 'When the monthly fee is invoiced', type: 'text', default: 'in arrears, after the end of each month' }, payment_days: { label: 'Payment due within (days)', type: 'number' }, approvers: { label: 'Client approvers', type: 'textarea' } },
    body: `# Project Management Services Agreement

${PARTIES('Client')}

## Project

The Client owns and funds the project {{workspace.name}} ({{workspace.ref}}) at {{workspace.location}}. SarayDar manages its execution on the Client's behalf. SarayDar is not the developer, funder or construction contractor unless separately agreed in writing.

## Services

{{services}}

Not included in SarayDar's services:

{{exclusions}}

## Fees

The Client will pay SarayDar a monthly management fee of {{monthly_fee_amount}}, invoiced {{billing_timing}} and payable within {{payment_days}} days of the invoice. The Client's construction budget, contractor payments and consultant fees are the Client's own costs and are not part of SarayDar's fee.

## Term

This Agreement starts on {{start_date}} for {{duration_months}} months, unless extended in writing.

## Client approvals

The following people may approve budgets, appointments, materials, variations and payments for the Client: {{approvers}}. SarayDar will record approvals received and will not commit the Client to costs without them.

## Termination

Either party may terminate on {{notices_days}} days' written notice. Fees are payable up to the termination date.

${GENERAL}

${SIGN('Client')}`
  },
  {
    key: 'lease_residential', name: 'Residential Lease Agreement', sections: ['props'], category: 'Lease', counterparty: 'Tenant',
    fields: { ...COMMON, unit: { label: 'Unit', type: 'text', required: true }, lease_start_date: { label: 'Lease start', type: 'date', required: true }, lease_end_date: { label: 'Lease end', type: 'date', required: true },
      rent_amount: { label: 'Monthly rent', type: 'money', required: true }, due_day: { label: 'Rent due on day of month', type: 'number', required: true }, deposit_amount: { label: 'Security deposit', type: 'money' },
      included_services: { label: 'Included services / utilities', type: 'textarea' }, occupants: { label: 'Authorised occupants', type: 'textarea' }, payment_instructions: { label: 'Payment instructions', type: 'textarea' }, landlord_name: { label: 'Landlord (owner) name', type: 'text', required: true } },
    body: `# Residential Lease Agreement

${PARTIES('Tenant')}

SarayDar signs this lease as manager acting for the landlord, {{landlord_name}}.

## Premises

Unit {{unit}} in {{workspace.name}}, {{workspace.location}} (the "Premises"), for residential use only by the authorised occupants: {{occupants}}

## Term

From {{lease_start_date}} to {{lease_end_date}}. Renewal requires a new written agreement.

## Rent

The monthly rent is {{rent_amount}}, due on day {{due_day}} of each month. Payment instructions: {{payment_instructions}}

A rent payment is recorded only when it has been received and confirmed.

## Security deposit

The Tenant pays a refundable security deposit of {{deposit_amount}}. It is held separately from rent and returned after the Tenant leaves, less documented amounts for unpaid charges or damage beyond normal wear and tear.

## Services

Included: {{included_services}}. All other utilities and charges are the Tenant's responsibility unless agreed in writing.

## Use and care

The Tenant will keep the Premises clean, report maintenance needs promptly, not alter the Premises or sublet without written consent, and allow access for inspections and repairs with reasonable notice.

## Maintenance

Responsibility for repairs follows the maintenance schedule agreed with the landlord. Damage caused by the Tenant or its occupants is charged to the Tenant.

## Move-in and move-out

The condition of the Premises, meter readings and keys will be recorded at move-in and move-out with photographs.

## Termination

Early termination requires {{notices_days}} days' written notice and is subject to the conditions agreed with the landlord.

${GENERAL}

${SIGN('Tenant')}`
  },
  {
    key: 'lease_commercial', name: 'Commercial Lease Agreement', sections: ['props'], category: 'Lease', counterparty: 'Tenant',
    fields: { ...COMMON, unit: { label: 'Unit', type: 'text', required: true }, permitted_use: { label: 'Permitted use', type: 'text', required: true }, lease_start_date: { label: 'Lease start', type: 'date', required: true },
      lease_end_date: { label: 'Lease end', type: 'date', required: true }, rent_amount: { label: 'Rent per period', type: 'money', required: true }, rent_period: { label: 'Rent period', type: 'text', default: 'month' },
      deposit_amount: { label: 'Security deposit', type: 'money' }, service_charge: { label: 'Service charges', type: 'textarea' }, fit_out: { label: 'Fit-out terms', type: 'textarea' }, landlord_name: { label: 'Landlord (owner) name', type: 'text', required: true } },
    body: `# Commercial Lease Agreement

${PARTIES('Tenant')}

SarayDar signs this lease as manager acting for the landlord, {{landlord_name}}.

## Premises and use

Unit {{unit}} in {{workspace.name}}, {{workspace.location}}, to be used only for: {{permitted_use}}. The Tenant is responsible for the licences needed for its business.

## Term

From {{lease_start_date}} to {{lease_end_date}}.

## Rent and charges

Rent is {{rent_amount}} per {{rent_period}}, payable in advance. Service charges: {{service_charge}}

## Security deposit

{{deposit_amount}}, held separately from rent and returned at the end of the lease less documented amounts owed.

## Fit-out and alterations

{{fit_out}}

No alterations without the landlord's prior written consent.

## Maintenance and access

The Tenant keeps the interior in good repair and allows access for inspections and repairs with reasonable notice.

## Termination

Either party may terminate for material breach not remedied within {{notices_days}} days of written notice.

${GENERAL}

${SIGN('Tenant')}`
  },
  {
    key: 'property_management', name: 'Property Management Agreement', sections: ['props'], category: 'Management agreement', counterparty: 'Owner',
    fields: { ...COMMON, services: { label: 'Services', type: 'textarea', required: true, default: 'Leasing, rent collection, tenant relations, cleaning, maintenance coordination and owner reporting.' },
      monthly_fee_amount: { label: 'Monthly management fee', type: 'money', required: true }, rent_collection: { label: 'Who collects rent and holds deposits', type: 'textarea', required: true },
      spending_limit_amount: { label: 'Maintenance spending limit without owner approval', type: 'money' }, reporting: { label: 'Owner reporting', type: 'text', default: 'Monthly owner statement' },
      fee_deduction: { label: 'May the fee be deducted from collected rent?', type: 'text' }, start_date: { label: 'Start date', type: 'date', required: true } },
    body: `# Property Management Agreement

${PARTIES('Owner')}

## Property

{{workspace.name}} at {{workspace.location}} (the "Property"), owned by the Owner.

## Services

SarayDar will manage the Property on the Owner's behalf: {{services}}

## Money handling

{{rent_collection}}

Tenant deposits are kept separate from rent income and from SarayDar's fees.

## Spending approvals

SarayDar may approve maintenance up to {{spending_limit_amount}} per item without prior approval. Larger amounts need the Owner's written approval, except documented emergencies to protect people or the Property.

## Fees

The Owner pays SarayDar a monthly fee of {{monthly_fee_amount}}. Deduction from collected rent: {{fee_deduction}}. Every deduction is shown on the owner statement with its fee invoice.

## Reporting

{{reporting}}, showing rent billed and collected, arrears, expenses, fees, deposits held and transfers.

## Term and termination

From {{start_date}}, until terminated by either party with {{notices_days}} days' written notice. SarayDar will hand over records, keys and funds held at termination.

${GENERAL}

${SIGN('Owner')}`
  },
  {
    key: 'maintenance_contract', name: 'Maintenance Services Contract', sections: ['props'], category: 'Service contract', counterparty: 'Service provider',
    fields: { ...COMMON, services: { label: 'Services', type: 'textarea', required: true }, frequency: { label: 'Visit frequency / response times', type: 'textarea' },
      fee_amount: { label: 'Fee', type: 'money', required: true }, fee_basis: { label: 'Fee basis', type: 'text', default: 'per month' }, start_date: { label: 'Start date', type: 'date', required: true }, end_date: { label: 'End date', type: 'date' } },
    body: `# Maintenance Services Contract

${PARTIES('Service provider')}

## Property

{{workspace.name}} at {{workspace.location}}.

## Services

{{services}}

Visits and response times: {{frequency}}

## Fee

{{fee_amount}} {{fee_basis}}. Parts and additional work are charged only when approved in writing beforehand, with a quotation.

## Records

The Service provider records each visit with date, work done and before/after photographs where relevant.

## Term

From {{start_date}} to {{end_date}}. Either party may terminate with {{notices_days}} days' written notice.

${GENERAL}

${SIGN('Service provider')}`
  },
  {
    key: 'sale_mandate', name: 'Property Sale Mandate', sections: ['sales'], category: 'Mandate', counterparty: 'Seller',
    fields: { ...COMMON, property_description: { label: 'Property', type: 'textarea', required: true }, exclusivity: { label: 'Exclusive or non-exclusive', type: 'text', required: true },
      asking_price_amount: { label: 'Asking price', type: 'money', required: true }, commission: { label: 'Commission (amount or % and its base)', type: 'text', required: true },
      commission_trigger: { label: 'When commission is earned', type: 'text', default: 'On completion of the sale' }, start_date: { label: 'Mandate start', type: 'date', required: true }, end_date: { label: 'Mandate end', type: 'date', required: true },
      marketing: { label: 'Approved marketing', type: 'textarea' } },
    body: `# Property Sale Mandate

${PARTIES('Seller')}

## Property

{{property_description}}

## Appointment

The Seller appoints SarayDar on a {{exclusivity}} basis to market the Property and find a buyer, from {{start_date}} to {{end_date}}. SarayDar confirms it acts for the Seller in this sale.

## Price authority

The asking price is {{asking_price_amount}}. Any change to the price, and acceptance of any offer, require the Seller's decision in writing.

## Marketing

{{marketing}}

## Commission

{{commission}}. Commission is earned: {{commission_trigger}}. The sale price is the Seller's money and is not SarayDar's income.

## Seller confirmations

The Seller confirms it owns the Property or is authorised to sell it and will provide the title documents needed.

## Termination

Either party may end this mandate with {{notices_days}} days' written notice.

${GENERAL}

${SIGN('Seller')}`
  },
  {
    key: 'search_mandate', name: 'Property Search (Buyer Representation) Agreement', sections: ['sales'], category: 'Mandate', counterparty: 'Buyer client',
    fields: { ...COMMON, brief: { label: 'Search brief (type, location, size, features)', type: 'textarea', required: true }, budget: { label: 'Budget range', type: 'text', required: true },
      fee: { label: 'Fee (amount or % and its base)', type: 'text', required: true }, fee_trigger: { label: 'When the fee is earned', type: 'text', default: 'On completion of a purchase' },
      start_date: { label: 'Start date', type: 'date', required: true }, end_date: { label: 'End date', type: 'date', required: true } },
    body: `# Property Search Agreement

${PARTIES('Buyer client')}

## Brief

The Buyer client asks SarayDar to find a property matching this brief:

{{brief}}

Budget: {{budget}}

## Services

SarayDar will search its own listings and other recorded opportunities, prepare shortlists, arrange viewings, help with offers and negotiation, and follow the purchase to completion. The Buyer client makes every purchase decision.

## Fee

{{fee}}. The fee is earned: {{fee_trigger}}. The purchase price is the Buyer client's money and is not SarayDar's income.

## Term

From {{start_date}} to {{end_date}}, unless extended in writing.

${GENERAL}

${SIGN('Buyer client')}`
  },
  {
    key: 'reservation', name: 'Property Reservation Form', sections: ['sales', 'dev'], category: 'Reservation', counterparty: 'Buyer',
    fields: { ...COMMON, property_description: { label: 'Property', type: 'textarea', required: true }, agreed_price_amount: { label: 'Agreed price', type: 'money', required: true },
      reservation_amount: { label: 'Reservation amount', type: 'money' }, reservation_holder: { label: 'Who holds the reservation amount', type: 'text', required: true },
      expiry_date: { label: 'Reservation expires on', type: 'date', required: true }, refund_terms: { label: 'Refund terms', type: 'textarea', required: true } },
    body: `# Property Reservation Form

${PARTIES('Buyer')}

## Property and price

{{property_description}}

Agreed price: {{agreed_price_amount}}

## Reservation

Reservation amount: {{reservation_amount}}, held by {{reservation_holder}}. The reservation expires on {{expiry_date}} unless a sale agreement is signed before then.

Refund terms: {{refund_terms}}

This form reserves the property; it is not a sale agreement and does not transfer ownership.

${GENERAL}

${SIGN('Buyer')}`
  },
  {
    key: 'co_broker', name: 'Co-broker Agreement', sections: ['sales'], category: 'Co-broker', counterparty: 'Co-broker',
    fields: { ...COMMON, case_description: { label: 'Property / case', type: 'textarea', required: true }, split: { label: 'Commission split', type: 'text', required: true },
      responsibilities: { label: 'Responsibilities of each party', type: 'textarea' }, end_date: { label: 'Valid until', type: 'date' } },
    body: `# Co-broker Agreement

${PARTIES('Co-broker')}

## Case

{{case_description}}

## Split

Commission received by SarayDar for this case will be shared as follows: {{split}}. A share is payable only after SarayDar has received its commission.

## Responsibilities

{{responsibilities}}

## Clients and confidentiality

Neither party will contact the other's clients about this case without agreement. Client information is confidential.

## Term

Valid until {{end_date}} or completion of the case.

${GENERAL}

${SIGN('Co-broker')}`
  }
];

module.exports = { STARTERS };
