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
