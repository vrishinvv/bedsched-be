import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildDirectionalConsolidationPlan,
  parseDirectionalLocationName,
} from '../common/directionalConsolidation.js';

test('recognizes directional location variants and preserves the section number', () => {
  assert.deepEqual(parseDirectionalLocationName('NORTH - 7'), {
    direction: 'North',
    sectionNumber: 7,
    sectionName: 'North 7',
  });
  assert.deepEqual(parseDirectionalLocationName('west_6'), {
    direction: 'West',
    sectionNumber: 6,
    sectionName: 'West 6',
  });
  assert.equal(parseDirectionalLocationName('North'), null);
  assert.equal(parseDirectionalLocationName('New Block A'), null);
});

test('builds a stable direction and section ordered plan', () => {
  const plan = buildDirectionalConsolidationPlan([
    { id: 4, name: 'South 6' },
    { id: 3, name: 'North 9' },
    { id: 2, name: 'North-3' },
    { id: 1, name: 'Shivam Enclave' },
  ]);
  assert.deepEqual(plan.map((row) => row.sectionName), ['North 3', 'North 9', 'South 6']);
});
