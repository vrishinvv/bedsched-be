export const ACCOMMODATION_CATEGORIES = Object.freeze(['delegate', 'sevadal', 'devotee']);

export class AccommodationEligibilityError extends Error {
  constructor(code, message, field = 'accommodationCategory') {
    super(message);
    this.name = 'AccommodationEligibilityError';
    this.code = code;
    this.field = field;
  }
}

export function normalizePersonGender(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (['male', 'm'].includes(normalized)) return 'Male';
  if (['female', 'f'].includes(normalized)) return 'Female';
  if (['other', 'o', 'non-binary', 'nonbinary'].includes(normalized)) return 'Other';
  return null;
}

export function resolveAllocationGender({ submittedGender, verifiedGender, isCaretaker = false } = {}) {
  const gender = normalizePersonGender(verifiedGender) || normalizePersonGender(submittedGender);
  if (!gender && isCaretaker) {
    fail('gender_required', 'Select the caretaker\'s gender.', 'gender');
  }
  return gender || 'Other';
}

export function validateGenderAllowedInBlock({ gender, genderRestriction } = {}) {
  const normalizedGender = normalizePersonGender(gender);
  if (genderRestriction === 'male_only' && normalizedGender !== 'Male') {
    fail('gender_restriction_violation', 'This block is restricted to male guests only.', 'gender');
  }
  if (genderRestriction === 'female_only' && normalizedGender !== 'Female') {
    fail('gender_restriction_violation', 'This block is restricted to female guests only.', 'gender');
  }
  return normalizedGender;
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

export function resolveMandatoryLookupCategory({
  verification,
  requestedCategory,
  isCaretaker = false,
  lookupRequired = true,
} = {}) {
  if (isCaretaker) return resolveUnverifiedCategory();
  if (!verification) {
    if (!lookupRequired) return resolveUnverifiedCategory();
    fail(
      'sai_connect_lookup_required',
      'Complete the Sai Connect lookup before allocating this bed.',
      'saiVerificationToken'
    );
  }
  if (!Array.isArray(verification.verifiedCategories) || verification.verifiedCategories.length === 0) {
    return resolveUnverifiedCategory();
  }
  return resolveVerifiedCategory({
    verifiedCategories: verification.verifiedCategories,
    requestedCategory,
  });
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

export function validateSaiIdentityAvailable({ identifier, existingAllocationId, isCaretaker = false } = {}) {
  if (isCaretaker || !identifier || !existingAllocationId) return;
  fail(
    'sai_connect_already_allocated',
    'This Sai Connect identity is already allocated to another bed.',
    'saiVerificationToken'
  );
}

export function validateBulkSaiIdentityAbsent(payload = {}) {
  const hasSaiIdentity = [
    payload.saiVerificationToken,
    payload.saiConnectId,
    payload.saiLookupIdentifier,
    payload.saiIdentifier,
    payload.Participant_id,
    payload.participantId,
    payload.identifier,
  ].some((value) => value !== undefined && value !== null && String(value).trim() !== '');
  if (!hasSaiIdentity) return;
  fail(
    'bulk_sai_identity_not_allowed',
    'Sai Connect identities cannot be bulk booked. Allocate each verified person individually.',
    'saiVerificationToken'
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
