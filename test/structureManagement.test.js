import assert from 'node:assert/strict';
import test from 'node:test';
import {
  StructureValidationError,
  validateBlockUpdateInput,
  validateCreateBlockInput,
  validateCreateTentInput,
  validateEntityId,
  validateStructureName,
} from '../common/structureManagement.js';

test('normalizes names and positive entity IDs', () => {
  assert.equal(validateStructureName('  Main Hall  ', 'name', 'Location'), 'Main Hall');
  assert.equal(validateEntityId('61'), 61);
  assert.deepEqual(validateCreateTentInput({ name: '  Tent A ' }), { name: 'Tent A' });
});

test('validates new block size and type', () => {
  assert.deepEqual(
    validateCreateBlockInput({ name: ' Block 4 ', size: '125', genderRestriction: 'female_only' }),
    { name: 'Block 4', size: 125, genderRestriction: 'female_only' }
  );
});

test('defaults a new block to mixed type', () => {
  assert.equal(
    validateCreateBlockInput({ name: 'Block 1', size: 50 }).genderRestriction,
    'both'
  );
});

test('accepts partial block updates', () => {
  assert.deepEqual(validateBlockUpdateInput({ size: 75 }), { size: 75 });
  assert.deepEqual(
    validateBlockUpdateInput({ name: ' West ', genderRestriction: 'male_only' }),
    { name: 'West', genderRestriction: 'male_only' }
  );
});

test('rejects empty names, invalid sizes, invalid types, and empty updates', () => {
  const cases = [
    [() => validateCreateTentInput({ name: '   ' }), 'name_required'],
    [() => validateCreateBlockInput({ name: 'Block', size: 0 }), 'invalid_block_size'],
    [() => validateCreateBlockInput({ name: 'Block', size: 10, genderRestriction: 'vip' }), 'invalid_block_type'],
    [() => validateBlockUpdateInput({}), 'no_changes'],
    [() => validateEntityId('not-an-id'), 'invalid_id'],
  ];

  for (const [operation, code] of cases) {
    assert.throws(
      operation,
      (error) => error instanceof StructureValidationError && error.code === code
    );
  }
});
