import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_ROOM_STATE_OPTION_NAME_LENGTH,
  RoomStateAssignmentError,
  normalizeRoomStateOptionId,
  normalizeRoomStateOptionName,
} from '../common/roomStateAssignments.js';

test('normalizes a custom option name', () => {
  assert.equal(normalizeRoomStateOptionName('  Tamil   Nadu  '), 'Tamil Nadu');
});

test('rejects blank and oversized custom option names', () => {
  for (const value of ['', '   ', null, 'x'.repeat(MAX_ROOM_STATE_OPTION_NAME_LENGTH + 1)]) {
    assert.throws(
      () => normalizeRoomStateOptionName(value),
      (error) => error instanceof RoomStateAssignmentError
        && error.code === 'invalid_state_option_name'
        && error.field === 'name',
    );
  }
});

test('normalizes a custom option id and permits an explicit clear', () => {
  assert.equal(normalizeRoomStateOptionId('12'), 12);
  assert.equal(normalizeRoomStateOptionId('', { allowEmpty: true }), null);
  assert.equal(normalizeRoomStateOptionId(null, { allowEmpty: true }), null);
});

test('rejects invalid custom option ids', () => {
  for (const value of [0, -1, 'abc', 1.5, null]) {
    assert.throws(
      () => normalizeRoomStateOptionId(value),
      (error) => error instanceof RoomStateAssignmentError && error.code === 'invalid_state_option',
    );
  }
});
