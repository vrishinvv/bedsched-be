import assert from 'node:assert/strict';
import test from 'node:test';

import { validateLinkedReallocationTarget } from '../common/reallocationEligibility.js';

test('a caretaker may move beds only within the Delegate block', () => {
  assert.deepEqual(validateLinkedReallocationTarget({
    currentBlockId: 11,
    targetBlockId: 11,
    caretakerForAllocationId: 101,
    hasCaretaker: false,
  }), {
    isCaretaker: true,
    hasLinkedCaretaker: false,
    isLinked: true,
  });

  assert.throws(
    () => validateLinkedReallocationTarget({
      currentBlockId: 11,
      targetBlockId: 12,
      caretakerForAllocationId: 101,
      hasCaretaker: false,
    }),
    (error) => error.code === 'linked_caretaker_reallocation'
  );
});

test('a Delegate with a caretaker may move beds only within their shared block', () => {
  assert.doesNotThrow(() => validateLinkedReallocationTarget({
    currentBlockId: 11,
    targetBlockId: 11,
    caretakerForAllocationId: null,
    hasCaretaker: true,
  }));

  assert.throws(
    () => validateLinkedReallocationTarget({
      currentBlockId: 11,
      targetBlockId: 12,
      caretakerForAllocationId: null,
      hasCaretaker: true,
    }),
    (error) => error.code === 'linked_caretaker_reallocation'
  );
});

test('an unlinked allocation can move to a different eligible block', () => {
  assert.deepEqual(validateLinkedReallocationTarget({
    currentBlockId: 11,
    targetBlockId: 12,
    caretakerForAllocationId: null,
    hasCaretaker: false,
  }), {
    isCaretaker: false,
    hasLinkedCaretaker: false,
    isLinked: false,
  });
});
