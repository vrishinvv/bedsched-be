export const ACCOMMODATION_CATEGORIES = Object.freeze(['delegate', 'sevadal', 'devotee']);

export function canAccessAllocationLocation(user, locationId) {
  if (user?.role === 'admin') return true;
  return user?.role === 'location_user'
    && Number.isFinite(Number(user.locationId))
    && Number(user.locationId) === Number(locationId);
}

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

export function resolveSaiIdentityPersistence({ verification, categorySource } = {}) {
  const verified = Boolean(verification) && (
    categorySource === 'sai_connect'
    || verification.outcome === 'matched'
    || verification.outcome === 'not_registered'
  );
  if (!verified) {
    return {
      lookupIdentifier: null,
      saiConnectId: null,
      age: null,
      verified: false,
    };
  }
  return {
    lookupIdentifier: String(verification.identifier || '').trim() || null,
    saiConnectId: String(verification.saiConnectId || '').trim() || null,
    age: Number.isInteger(verification.age) ? verification.age : null,
    verified: true,
  };
}

export function resolveSaiProfileForAllocation({
  user,
  verification,
  submittedName,
  submittedPhone,
} = {}) {
  const isMatched = verification?.outcome === 'matched'
    || (Array.isArray(verification?.verifiedCategories) && verification.verifiedCategories.length > 0);
  const mustUseVerifiedProfile = user?.role !== 'admin' && isMatched;
  const verifiedName = isMatched ? String(verification?.fullName || '').trim() : '';
  const verifiedPhone = isMatched && /^\d{10}$/.test(String(verification?.mobileNo || '').trim())
    ? String(verification.mobileNo).trim()
    : null;
  const cleanSubmittedName = String(submittedName || '').trim();
  const cleanSubmittedPhone = String(submittedPhone || '').trim();
  return {
    name: mustUseVerifiedProfile && verifiedName
      ? verifiedName
      : (cleanSubmittedName || verifiedName),
    phone: mustUseVerifiedProfile && verifiedPhone
      ? verifiedPhone
      : (cleanSubmittedPhone || verifiedPhone || null),
    verifiedGender: mustUseVerifiedProfile ? verification?.gender || null : null,
  };
}

export function resolveSaiIdentityLookupCriteria({
  saiConnectId,
  lookupIdentifier,
  mobileNo,
} = {}) {
  const cleanSaiId = String(saiConnectId || '').trim() || null;
  const cleanLookup = String(lookupIdentifier || '').trim() || null;
  const rawMobile = String(mobileNo || '').replace(/\D/g, '');
  const lookupDigits = String(cleanLookup || '').replace(/\D/g, '');
  const cleanMobile = /^\d{10}$/.test(rawMobile)
    ? rawMobile
    : (/^\d{10}$/.test(lookupDigits) && lookupDigits === cleanLookup ? lookupDigits : null);
  const lockKeys = Array.from(
    new Set([cleanSaiId, cleanLookup, cleanMobile].filter(Boolean))
  ).sort();
  return {
    saiConnectId: cleanSaiId,
    lookupIdentifier: cleanLookup,
    mobileNo: cleanMobile,
    hasCriteria: Boolean(cleanSaiId || cleanLookup || cleanMobile),
    lockKeys,
  };
}

export function validateCaretakerDeallocationAllowed({
  targetIds = [],
  activeCaretakers = [],
  batchMode = false,
} = {}) {
  const targetSet = new Set(targetIds.map((id) => Number(id)));
  const orphaned = activeCaretakers.find((row) => {
    const caretakerId = Number(row.id ?? row.caretaker_id ?? row.caretakerId);
    const delegateId = Number(row.caretaker_for_allocation_id ?? row.delegate_id ?? row.delegateId);
    return targetSet.has(delegateId) && !targetSet.has(caretakerId);
  });
  if (orphaned) {
    fail(
      'delegate_has_caretaker',
      batchMode
        ? 'Include the linked caretaker when deallocating a Delegate.'
        : 'Remove the linked caretaker before removing this Delegate.',
      'caretakerForAllocationId'
    );
  }
}

export function normalizeDateString(val) {
  if (!val) return '';
  if (val instanceof Date) {
    if (Number.isNaN(val.getTime())) return '';
    if (
      val.getHours() === 0
      && val.getMinutes() === 0
      && val.getSeconds() === 0
      && val.getMilliseconds() === 0
    ) {
      const y = val.getFullYear();
      const m = String(val.getMonth() + 1).padStart(2, '0');
      const d = String(val.getDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
    }
    return val.toISOString().slice(0, 10);
  }
  return String(val).trim().slice(0, 10);
}

export function isValidIsoDateString(value) {
  const str = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
  const [year, month, day] = str.split('-').map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day));
  return (
    utc.getUTCFullYear() === year
    && utc.getUTCMonth() === month - 1
    && utc.getUTCDate() === day
  );
}

export function validateAllocationDateRange({ startDate, endDate } = {}) {
  const start = normalizeDateString(startDate);
  const end = normalizeDateString(endDate);
  if (!isValidIsoDateString(start) || !isValidIsoDateString(end)) {
    fail('invalid_date_range', 'Enter valid start and end dates in YYYY-MM-DD format.', 'startDate');
  }
  if (start > end) {
    fail('invalid_date_range', 'End date must be on or after start date.', 'endDate');
  }
  return { startDate: start, endDate: end };
}

export function validateCaretakerDateEditAllowed({
  isCaretaker = false,
  currentStartDate,
  currentEndDate,
  nextStartDate,
  nextEndDate,
} = {}) {
  if (!isCaretaker) return;
  const startChanged = nextStartDate !== undefined
    && normalizeDateString(nextStartDate) !== normalizeDateString(currentStartDate);
  const endChanged = nextEndDate !== undefined
    && normalizeDateString(nextEndDate) !== normalizeDateString(currentEndDate);
  if (startChanged || endChanged) {
    fail(
      'caretaker_dates_locked',
      'Caretaker stay dates follow the linked Delegate and cannot be edited independently.',
      'startDate'
    );
  }
}

export function validateSaiProfileEditPermission({ user, current, updates } = {}) {
  const hasVerifiedSaiProfile = current?.category_source === 'sai_connect'
    || (Array.isArray(current?.verified_categories) && current.verified_categories.length > 0);
  if (user?.role === 'admin' || !hasVerifiedSaiProfile) return;
  const changed = (
    updates?.name !== undefined
    && String(updates.name || '').trim() !== String(current.name || '').trim()
  ) || (
    updates?.phone !== undefined
    && String(updates.phone || '').trim() !== String(current.phone || '').trim()
  ) || (
    updates?.gender !== undefined
    && normalizePersonGender(updates.gender) !== normalizePersonGender(current.gender)
  );
  if (changed) {
    fail(
      'sai_profile_locked',
      'Sai Connect profile fields can only be changed by an administrator.',
      'saiConnectId'
    );
  }
}

export function validateRequiredBookingPhotos({
  photosRequired = false,
  isCaretaker = false,
  personPhotoKey,
  aadhaarPhotoKey,
} = {}) {
  if (!photosRequired) return;
  if (isCaretaker) {
    if (!String(personPhotoKey || '').trim() || !String(aadhaarPhotoKey || '').trim()) {
      fail(
        'caretaker_photo_required',
        'A caretaker photo and Aadhaar/identity photo are required for this booking.',
        'photos'
      );
    }
    return;
  }
  if (!String(personPhotoKey || '').trim() || !String(aadhaarPhotoKey || '').trim()) {
    fail(
      'booking_photos_required',
      'Both a person photo and an identity photo are required for this booking.',
      'photos'
    );
  }
}

export function resolveMandatoryLookupCategory({
  verification,
  requestedCategory,
  isCaretaker = false,
  lookupRequired = true,
} = {}) {
  if (isCaretaker && !verification) return resolveUnverifiedCategory();
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

export function validateAdminCategoryChange(value, { currentCategory = null, hasActiveCaretaker = false } = {}) {
  if (currentCategory && value === currentCategory) {
    return value;
  }
  if (currentCategory === 'delegate' && value !== 'delegate' && hasActiveCaretaker) {
    fail('delegate_has_caretaker', 'Remove the linked caretaker before changing this Delegate’s category.');
  }
  if (value === 'delegate') {
    fail('delegate_requires_verification', 'Delegate status requires Sai Connect verification.');
  }
  if (!['sevadal', 'devotee'].includes(value)) {
    fail('invalid_category', 'Select Sevadal or Devotee.');
  }
  return value;
}

export function validateAccommodationCategoryEditPermission(user) {
  if (user?.role !== 'admin') {
    fail('forbidden', 'Only an administrator can change accommodation category.');
  }
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

export function formatExistingAllocationAddress(allocation) {
  if (!allocation) return '';
  const locationId = allocation.locationId ?? allocation.location_id;
  const tentIndex = allocation.tentIndex ?? allocation.tent_index;
  const blockIndex = allocation.blockIndex ?? allocation.block_index;
  const location = allocation.locationName || allocation.location_name || (locationId != null ? `Location ${locationId}` : '');
  const tent = allocation.tentName || allocation.tent_name || (tentIndex != null ? `Tent ${tentIndex}` : '');
  const block = allocation.blockName || allocation.block_name || (blockIndex != null ? `Block ${blockIndex}` : '');
  const bed = allocation.bedNumber ?? allocation.bed_number;
  if (!location || !tent || !block || bed == null) return '';
  return `${location} / ${tent} / ${block} / Bed ${bed}`;
}

export function validateSaiIdentityAvailable({ identifier, existingAllocation, existingAllocationId } = {}) {
  const allocation = existingAllocation || (existingAllocationId ? { id: existingAllocationId } : null);
  if (!identifier || !allocation) return;
  const address = formatExistingAllocationAddress(allocation);
  fail(
    'sai_connect_already_allocated',
    address
      ? `This Sai Connect ID is already booked at ${address}.`
      : 'This Sai Connect ID is already booked.',
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
