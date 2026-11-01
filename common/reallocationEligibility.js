import { AccommodationEligibilityError } from './accommodationEligibility.js';

export function validateLinkedReallocationTarget({
  currentBlockId,
  targetBlockId,
  caretakerForAllocationId,
  hasCaretaker,
}) {
  const isCaretaker = caretakerForAllocationId !== null && caretakerForAllocationId !== undefined;
  const hasLinkedCaretaker = Boolean(hasCaretaker);
  const isLinked = isCaretaker || hasLinkedCaretaker;

  if (isLinked && Number(currentBlockId) !== Number(targetBlockId)) {
    throw new AccommodationEligibilityError(
      'linked_caretaker_reallocation',
      'A caretaker and their Delegate must remain in the same block. Choose another bed in their current block.',
      'newBlockId'
    );
  }

  return { isCaretaker, hasLinkedCaretaker, isLinked };
}
