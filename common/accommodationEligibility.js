export const ACCOMMODATION_CATEGORIES = Object.freeze(['delegate', 'sevadal', 'devotee']);

export class AccommodationEligibilityError extends Error {
  constructor(code, message, field = 'accommodationCategory') {
    super(message);
    this.name = 'AccommodationEligibilityError';
    this.code = code;
    this.field = field;
  }
}

function fail(code, message, field) {
  throw new AccommodationEligibilityError(code, message, field);
}

export function normalizeAccommodationCategories(value, { defaultToAll = false } = {}) {
  if (value === undefined && defaultToAll) return [...ACCOMMODATION_CATEGORIES];
  if (!Array.isArray(value) || value.length === 0) {
    fail('category_required', 'Select at least one accommodation category.', 'allowedCategories');
  }

  const requested = new Set(value);
  for (const category of requested) {
    if (!ACCOMMODATION_CATEGORIES.includes(category)) {
      fail('invalid_category', 'Select only Delegate, Sevadal, or Devotee.', 'allowedCategories');
    }
  }

  return ACCOMMODATION_CATEGORIES.filter((category) => requested.has(category));
}

export function resolveUnverifiedCategory() {
  return {
    accommodationCategory: 'devotee',
    categorySource: 'default',
    verifiedCategories: [],
  };
}

export function resolveVerifiedCategory({ verifiedCategories, requestedCategory } = {}) {
  const normalized = normalizeAccommodationCategories(verifiedCategories);
  const eligible = normalized.filter((category) => category !== 'devotee');
  if (eligible.length === 0) return resolveUnverifiedCategory();

  let accommodationCategory = requestedCategory;
  if (!accommodationCategory) {
    if (eligible.length > 1) {
      fail(
        'category_selection_required',
        'Choose whether this person is being accommodated as a Delegate or Sevadal.'
      );
    }
    [accommodationCategory] = eligible;
  }

  if (!eligible.includes(accommodationCategory)) {
    fail('category_not_verified', 'Sai Connect did not verify the selected category.');
  }

  return {
    accommodationCategory,
    categorySource: 'sai_connect',
    verifiedCategories: eligible,
  };
}

export function validateAdminCategoryChange(value) {
  if (value === 'delegate') {
    fail('delegate_requires_verification', 'Delegate status requires Sai Connect verification.');
  }
  if (!['sevadal', 'devotee'].includes(value)) {
    fail('invalid_category', 'Select Sevadal or Devotee.');
  }
  return value;
}

export function validateCategoryAllowedInBlock({ accommodationCategory, allowedCategories, isCaretaker = false }) {
  const allowed = normalizeAccommodationCategories(allowedCategories);
  if (isCaretaker || allowed.includes(accommodationCategory)) return accommodationCategory;
  fail(
    'category_not_allowed_in_block',
    `This block does not allow ${accommodationCategory} accommodation.`,
    'accommodationCategory'
  );
}

export function validateCaretakerTarget({ targetAllocation, blockId, hasCaretaker }) {
  if (!targetAllocation || targetAllocation.deleted_at) {
    fail('delegate_not_active', 'Select an active delegate in this block.', 'caretakerForAllocationId');
  }
  if (targetAllocation.accommodation_category !== 'delegate') {
    fail('caretaker_requires_delegate', 'A caretaker must be linked to a Delegate.', 'caretakerForAllocationId');
  }
  if (Number(targetAllocation.block_id) !== Number(blockId)) {
    fail('caretaker_same_block_required', 'The caretaker must stay in the same block as the Delegate.', 'caretakerForAllocationId');
  }
  if (hasCaretaker) {
    fail('caretaker_already_assigned', 'This Delegate already has a caretaker.', 'caretakerForAllocationId');
  }

  return {
    delegateAllocationId: Number(targetAllocation.id),
    startDate: targetAllocation.start_date,
    endDate: targetAllocation.end_date,
  };
}
