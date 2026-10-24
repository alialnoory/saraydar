'use strict';
// Tick-box groups post one combined answer; the field shows stored answers ticked again.
const test = require('node:test');
const assert = require('node:assert/strict');
const { combineChecks } = require('../portal/choices');
const { field } = require('../portal/views');

test('tick-box groups', async t => {
  await t.test('ticks and "other" lines become one newline-separated answer', () => {
    const req = { body: { scope__checks: '1', scope__pick: ['Construction supervision', 'Monthly progress reports'], scope__other: 'Snag list\n\nSnag list', name: 'x' } };
    combineChecks(req, null, () => {});
    assert.equal(req.body.scope, 'Construction supervision\nMonthly progress reports\nSnag list');
    assert.equal(req.body.scope__pick, undefined);
    assert.equal(req.body.name, 'x');
  });
  await t.test('nothing ticked gives an empty answer', () => {
    const req = { body: { risks__checks: '1', risks__other: '' } };
    combineChecks(req, null, () => {});
    assert.equal(req.body.risks, '');
  });
  await t.test('stored answers show ticked; unknown lines go to "other"', () => {
    const out = String(field({ name: 'scope', label: 'Scope', type: 'checks', options: ['A', 'B'], value: 'B\nC' }));
    assert.match(out, /value="B" checked/);
    assert.doesNotMatch(out, /value="A" checked/);
    assert.match(out, /<textarea[^>]*name="scope__other"[^>]*>C<\/textarea>/);
  });
  await t.test('suggestion lists are closed options inside a datalist', () => {
    const out = String(field({ name: 'location', label: 'Location', list: ['Seef', 'Saar'] }));
    assert.match(out, /list="dl-location-/);
    assert.match(out, /<option value="Seef"><\/option>/);
  });
});
