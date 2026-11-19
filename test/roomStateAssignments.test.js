import assert from 'node:assert/strict';
import test from 'node:test';
import {
  INDIAN_STATES,
  RoomStateAssignmentError,
  getIndianState,
  normalizeIndianStateCode,
} from '../common/roomStateAssignments.js';

test('provides the 28 Indian states without union territories', () => {
  assert.equal(INDIAN_STATES.length, 28);
  assert.deepEqual(getIndianState('TN'), { code: 'TN', name: 'Tamil Nadu' });
  assert.deepEqual(getIndianState('TS'), { code: 'TS', name: 'Telangana' });
  assert.equal(getIndianState('DL'), null);
});

test('normalizes a valid state code and permits an explicit clear', () => {
  assert.equal(normalizeIndianStateCode(' tn '), 'TN');
  assert.equal(normalizeIndianStateCode('', { allowEmpty: true }), null);
  assert.equal(normalizeIndianStateCode(null, { allowEmpty: true }), null);
});

test('rejects invalid states and union territories', () => {
  for (const value of ['DL', 'Puducherry', '', null]) {
    assert.throws(
      () => normalizeIndianStateCode(value),
      (error) => error instanceof RoomStateAssignmentError && error.code === 'invalid_state',
    );
  }
});
