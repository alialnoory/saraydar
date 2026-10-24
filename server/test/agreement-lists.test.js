'use strict';
// Lists in agreements: ticked lines become bullets, numbered lines keep their numbers, tabs never reach the PDF.
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../lib/agreements');

test('agreement lists', async () => {
  const f = [{ key: 'services', type: 'textarea' }, { key: 'exclusions', type: 'textarea' }];
  const ticked = A.resolve(f, { services: 'Construction supervision\nMonthly progress reports', exclusions: '' }, {});
  assert.equal(ticked.services, '- Construction supervision\n- Monthly progress reports');
  assert.equal(ticked.exclusions, 'None.');
  const typed = A.resolve(f, { services: 'SarayDar undertakes:\n1.\tPreparing the plan\n2.\tManaging works' }, {});
  assert.equal(typed.services, 'SarayDar undertakes:\n1.\tPreparing the plan\n2.\tManaging works');
  const pdf = await A.renderPdf({ text: A.fill('# T\n\n{{services}}', typed), ref: 'AGR-1' });
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.ok((await A.renderDocx({ text: A.fill('# T\n\n{{services}}', typed), ref: 'AGR-1' })).length > 1000);
});

test('the other party: CPR for individuals, CR for companies, and who represents them', () => {
  const person = A.builtins({ party: { name: 'Sara Alsamaheeji', kind: 'person', representative: 'Mahdi Al Maskati', representative_title: 'Attorney', representative_cpr: '800101234' } });
  assert.equal(person['party.id_label'], 'CPR No.');
  assert.equal(person['party.represented_by'], ', represented by Mahdi Al Maskati (CPR No. 800101234), Attorney');
  assert.equal(person['party.signatory'], 'Mahdi Al Maskati');
  const co = A.builtins({ party: { name: 'ACME WLL', kind: 'company', contact_person: 'Ahmed Ali' } });
  assert.equal(co['party.id_label'], 'CR No.');
  assert.equal(co['party.represented_by'], ', represented by Ahmed Ali');
  assert.equal(co['party.signatory_title'], "Client's Representative");
  assert.equal(A.builtins({ party: { name: 'Sara', kind: 'person' } })['party.represented_by'], '');
});
