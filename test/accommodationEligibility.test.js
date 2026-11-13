import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AccommodationEligibilityError,
  canAccessAllocationLocation,
  isValidIsoDateString,
  normalizeDateString,
  resolveMandatoryLookupCategory,
  resolveAllocationGender,
  resolveSaiIdentityLookupCriteria,
  resolveSaiIdentityPersistence,
  resolveSaiProfileForAllocation,
  resolveVerifiedCategory,
  resolveUnverifiedCategory,
  validateAdminCategoryChange,
  validateAccommodationCategoryEditPermission,
  validateAllocationDateRange,
  validateCategoryAllowedInBlock,
  validateBulkSaiIdentityAbsent,
  validateCaretakerDateEditAllowed,
  validateCaretakerDeallocationAllowed,
  validateCaretakerTarget,
  validateGenderAllowedInBlock,
  validateSaiIdentityAvailable,
  validateSaiProfileEditPermission,
  validateRequiredBookingPhotos,
} from '../common/accommodationEligibility.js';

test('allocation access is limited to an administrator or the assigned location', () => {
  assert.equal(canAccessAllocationLocation({ role: 'admin' }, 61), true);
  assert.equal(canAccessAllocationLocation({ role: 'location_user', locationId: 61 }, 61), true);
  assert.equal(canAccessAllocationLocation({ role: 'location_user', locationId: 19 }, 61), false);
  assert.equal(canAccessAllocationLocation({ role: 'dashboard' }, 61), false);
  assert.equal(canAccessAllocationLocation(null, 61), false);
});

test('production photo enforcement requires person and identity photos for guests and caretakers', () => {
  assert.throws(
    () => validateRequiredBookingPhotos({ photosRequired: true, personPhotoKey: 'person.jpg' }),
    (error) => error instanceof AccommodationEligibilityError
      && error.code === 'booking_photos_required',
  );
  assert.doesNotThrow(() => validateRequiredBookingPhotos({
    photosRequired: true,
    personPhotoKey: 'person.jpg',
    aadhaarPhotoKey: 'identity.jpg',
  }));
  assert.doesNotThrow(() => validateRequiredBookingPhotos({ photosRequired: false }));
  assert.throws(
    () => validateRequiredBookingPhotos({ photosRequired: true, isCaretaker: true }),
    (error) => error instanceof AccommodationEligibilityError
      && error.code === 'caretaker_photo_required',
  );
  assert.doesNotThrow(() => validateRequiredBookingPhotos({
    photosRequired: true,
    isCaretaker: true,
    personPhotoKey: 'caretaker.jpg',
    aadhaarPhotoKey: 'caretaker-identity.jpg',
  }));
  assert.throws(
    () => validateRequiredBookingPhotos({
      photosRequired: true,
      isCaretaker: true,
      personPhotoKey: 'caretaker.jpg',
    }),
    (error) => error instanceof AccommodationEligibilityError
      && error.code === 'caretaker_photo_required',
  );
});

test('Sai-verified gender is authoritative for an allocation', () => {
  assert.equal(resolveAllocationGender({
    submittedGender: 'Male',
    verifiedGender: 'female',
  }), 'Female');
});

test('a caretaker must provide a valid gender', () => {
  assert.equal(resolveAllocationGender({ submittedGender: 'Female', isCaretaker: true }), 'Female');
  assert.throws(
    () => resolveAllocationGender({ submittedGender: '', isCaretaker: true }),
    (error) => error instanceof AccommodationEligibilityError
      && error.code === 'gender_required'
  );
});

test('gender restrictions apply to caretakers and Sai-verified occupants alike', () => {
  assert.equal(validateGenderAllowedInBlock({ gender: 'Male', genderRestriction: 'male_only' }), 'Male');
  assert.throws(
    () => validateGenderAllowedInBlock({ gender: 'Female', genderRestriction: 'male_only' }),
    (error) => error instanceof AccommodationEligibilityError
      && error.code === 'gender_restriction_violation'
      && error.message === 'This block is restricted to male guests only.'
  );
});

test('a normal allocation requires completed Sai Connect lookup proof', () => {
  assert.throws(
    () => resolveMandatoryLookupCategory({ verification: null }),
    (error) => error instanceof AccommodationEligibilityError
      && error.code === 'sai_connect_lookup_required'
  );
});

test('Sai Connect lookup remains optional when the block allows Devotees', () => {
  assert.deepEqual(
    resolveMandatoryLookupCategory({ verification: null, lookupRequired: false }),
    {
      accommodationCategory: 'devotee',
      categorySource: 'default',
      verifiedCategories: [],
    }
  );
});

test('a completed lookup without registration resolves to Devotee', () => {
  assert.deepEqual(
    resolveMandatoryLookupCategory({
      verification: { outcome: 'not_registered', verifiedCategories: [] },
    }),
    {
      accommodationCategory: 'devotee',
      categorySource: 'default',
      verifiedCategories: [],
    }
  );
});

test('persists only valid Sai Connect identities, including valid people with no event registration', () => {
  assert.deepEqual(resolveSaiIdentityPersistence({
    verification: {
      outcome: 'not_registered',
      identifier: '800717',
      saiConnectId: '800717',
    },
    categorySource: 'default',
  }), {
    lookupIdentifier: '800717',
    saiConnectId: '800717',
    age: null,
    verified: true,
  });

  assert.deepEqual(resolveSaiIdentityPersistence({
    verification: { outcome: 'invalid', identifier: '123456' },
    categorySource: 'default',
  }), {
    lookupIdentifier: null,
    saiConnectId: null,
    age: null,
    verified: false,
  });
});

test('Sai-sourced profile fields are authoritative for location users but editable by admins', () => {
  const verification = {
    outcome: 'matched',
    fullName: 'Sai Name',
    mobileNo: '9876543210',
    gender: 'Female',
    verifiedCategories: ['delegate'],
  };

  assert.deepEqual(resolveSaiProfileForAllocation({
    user: { role: 'location_user' },
    verification,
    submittedName: 'Changed Name',
    submittedPhone: '9999999999',
    submittedGender: 'Male',
  }), {
    name: 'Sai Name',
    phone: '9876543210',
    verifiedGender: 'Female',
  });

  assert.deepEqual(resolveSaiProfileForAllocation({
    user: { role: 'admin' },
    verification,
    submittedName: 'Changed Name',
    submittedPhone: '9999999999',
    submittedGender: 'Male',
  }), {
    name: 'Changed Name',
    phone: '9999999999',
    verifiedGender: null,
  });
});

test('location users cannot change an existing Sai-sourced profile while admins can', () => {
  assert.throws(
    () => validateSaiProfileEditPermission({
      user: { role: 'location_user' },
      current: {
        category_source: 'sai_connect',
        name: 'Sai Name',
        phone: '9876543210',
        gender: 'Female',
      },
      updates: { name: 'Changed Name' },
    }),
    (error) => error instanceof AccommodationEligibilityError
      && error.code === 'sai_profile_locked'
  );

  assert.doesNotThrow(() => validateSaiProfileEditPermission({
    user: { role: 'location_user' },
    current: {
      category_source: 'sai_connect',
      name: 'Sai Name',
      phone: '9876543210',
      gender: 'Female',
    },
    updates: { name: 'Sai Name', phone: '9876543210', gender: 'Female' },
  }));

  assert.doesNotThrow(() => validateSaiProfileEditPermission({
    user: { role: 'admin' },
    current: { category_source: 'sai_connect', name: 'Sai Name' },
    updates: { name: 'Changed Name' },
  }));

  assert.throws(
    () => validateSaiProfileEditPermission({
      user: { role: 'location_user' },
      current: {
        category_source: 'manual',
        verified_categories: ['delegate'],
        name: 'Admin Adjusted Sai Name',
      },
      updates: { name: 'Location User Change' },
    }),
    (error) => error instanceof AccommodationEligibilityError
      && error.code === 'sai_profile_locked'
  );

  assert.doesNotThrow(() => validateSaiProfileEditPermission({
    user: { role: 'location_user' },
    current: {
      category_source: 'default',
      verified_categories: [],
      name: 'Valid Unregistered Devotee',
    },
    updates: { name: 'Corrected Devotee Name' },
  }));
});

test('a caretaker may skip Sai Connect, but verified caretaker categories are preserved', () => {
  assert.deepEqual(
    resolveMandatoryLookupCategory({ verification: null, isCaretaker: true }),
    {
      accommodationCategory: 'devotee',
      categorySource: 'default',
      verifiedCategories: [],
    }
  );

  assert.deepEqual(
    resolveMandatoryLookupCategory({
      verification: { verifiedCategories: ['sevadal'] },
      requestedCategory: 'sevadal',
      isCaretaker: true,
    }),
    {
      accommodationCategory: 'sevadal',
      categorySource: 'sai_connect',
      verifiedCategories: ['sevadal'],
    }
  );
});

test('a verified Sai Connect identity can have only one active allocation, including caretakers', () => {
  assert.throws(
    () => validateSaiIdentityAvailable({
      identifier: '239910',
      existingAllocation: {
        id: 81,
        location_name: 'Anand Vilas Enclave',
        tent_name: 'Tent A',
        block_name: 'Block 1',
        bed_number: 25,
      },
    }),
    (error) => error instanceof AccommodationEligibilityError
      && error.code === 'sai_connect_already_allocated'
      && error.message === 'This Sai Connect ID is already booked at Anand Vilas Enclave / Tent A / Block 1 / Bed 25.'
  );

  assert.throws(
    () => validateSaiIdentityAvailable({
      identifier: '239910',
      existingAllocationId: 81,
      isCaretaker: true,
    }),
    (error) => error instanceof AccommodationEligibilityError
      && error.code === 'sai_connect_already_allocated'
  );

  assert.doesNotThrow(() => validateSaiIdentityAvailable({ identifier: null, existingAllocationId: 81 }));
});

test('a Sai Connect identity cannot be attached to a bulk booking', () => {
  for (const payload of [
    { saiVerificationToken: 'verified-person-token' },
    { saiConnectId: '239910' },
    { Participant_id: 239910 },
  ]) {
    assert.throws(
      () => validateBulkSaiIdentityAbsent(payload),
      (error) => error instanceof AccommodationEligibilityError
        && error.code === 'bulk_sai_identity_not_allowed'
        && error.message === 'Sai Connect identities cannot be bulk booked. Allocate each verified person individually.'
    );
  }

  assert.doesNotThrow(() => validateBulkSaiIdentityAbsent({ name: 'Unverified group booking' }));
});

test('an unverified person is allocated as a devotee by default', () => {
  assert.deepEqual(resolveUnverifiedCategory(), {
    accommodationCategory: 'devotee',
    categorySource: 'default',
    verifiedCategories: [],
  });
});

test('a single verified category is selected automatically', () => {
  assert.deepEqual(
    resolveVerifiedCategory({ verifiedCategories: ['sevadal'] }),
    {
      accommodationCategory: 'sevadal',
      categorySource: 'sai_connect',
      verifiedCategories: ['sevadal'],
    }
  );
});

test('a person verified as delegate and sevadal must be allocated under one selected category', () => {
  assert.throws(
    () => resolveVerifiedCategory({ verifiedCategories: ['delegate', 'sevadal'] }),
    (error) => error instanceof AccommodationEligibilityError
      && error.code === 'category_selection_required'
  );

  assert.equal(
    resolveVerifiedCategory({
      verifiedCategories: ['delegate', 'sevadal'],
      requestedCategory: 'delegate',
    }).accommodationCategory,
    'delegate'
  );
});

test('a verified person cannot be allocated under a category Sai Connect did not return', () => {
  assert.throws(
    () => resolveVerifiedCategory({
      verifiedCategories: ['sevadal'],
      requestedCategory: 'delegate',
    }),
    (error) => error instanceof AccommodationEligibilityError
      && error.code === 'category_not_verified'
  );
});

test('admins may manually change a category to devotee or sevadal but never delegate', () => {
  assert.equal(validateAdminCategoryChange('devotee'), 'devotee');
  assert.equal(validateAdminCategoryChange('sevadal'), 'sevadal');
  assert.throws(
    () => validateAdminCategoryChange('delegate'),
    (error) => error instanceof AccommodationEligibilityError
      && error.code === 'delegate_requires_verification'
  );
});

test('only admins may edit the accommodation category of an existing booking', () => {
  assert.doesNotThrow(() => validateAccommodationCategoryEditPermission({ role: 'admin' }));
  assert.throws(
    () => validateAccommodationCategoryEditPermission({ role: 'location_user' }),
    (error) => error instanceof AccommodationEligibilityError
      && error.code === 'forbidden'
      && error.message === 'Only an administrator can change accommodation category.'
  );
});

test('a normal allocation must match the block categories while a caretaker may be the exception', () => {
  assert.equal(validateCategoryAllowedInBlock({
    accommodationCategory: 'delegate',
    allowedCategories: ['delegate'],
  }), 'delegate');
  assert.throws(() => validateCategoryAllowedInBlock({
    accommodationCategory: 'devotee',
    allowedCategories: ['delegate'],
  }), /does not allow devotee/);
  assert.equal(validateCategoryAllowedInBlock({
    accommodationCategory: 'devotee',
    allowedCategories: ['delegate'],
    isCaretaker: true,
  }), 'devotee');
});

test('a caretaker must link to an active delegate in the same block with no caretaker', () => {
  const target = {
    id: 81,
    block_id: 12,
    accommodation_category: 'delegate',
    start_date: '2026-11-05',
    end_date: '2026-11-24',
    deleted_at: null,
  };

  assert.deepEqual(
    validateCaretakerTarget({ targetAllocation: target, blockId: 12, hasCaretaker: false }),
    { delegateAllocationId: 81, startDate: '2026-11-05', endDate: '2026-11-24' }
  );

  const invalidCases = [
    [{ ...target, accommodation_category: 'sevadal' }, 12, false, 'caretaker_requires_delegate'],
    [{ ...target, block_id: 13 }, 12, false, 'caretaker_same_block_required'],
    [{ ...target, deleted_at: '2026-10-31T00:00:00Z' }, 12, false, 'delegate_not_active'],
    [target, 12, true, 'caretaker_already_assigned'],
  ];

  for (const [targetAllocation, blockId, hasCaretaker, code] of invalidCases) {
    assert.throws(
      () => validateCaretakerTarget({ targetAllocation, blockId, hasCaretaker }),
      (error) => error instanceof AccommodationEligibilityError && error.code === code
    );
  }
});

test('admin allocations fall back to Sai-verified name and phone when submitted fields are null or blank', () => {
  const verification = {
    outcome: 'matched',
    fullName: 'Verified Caretaker',
    mobileNo: '9876543210',
    gender: 'Male',
    verifiedCategories: ['sevadal'],
  };

  assert.deepEqual(resolveSaiProfileForAllocation({
    user: { role: 'admin' },
    verification,
    submittedName: 'Verified Caretaker',
    submittedPhone: null,
  }), {
    name: 'Verified Caretaker',
    phone: '9876543210',
    verifiedGender: null,
  });

  assert.deepEqual(resolveSaiProfileForAllocation({
    user: { role: 'admin' },
    verification,
    submittedName: '',
    submittedPhone: '   ',
  }), {
    name: 'Verified Caretaker',
    phone: '9876543210',
    verifiedGender: null,
  });
});

test('resolveSaiIdentityLookupCriteria normalizes Sai Connect ID, lookup identifier, and mobile number for cross-identifier duplicate prevention', () => {
  assert.deepEqual(resolveSaiIdentityLookupCriteria({
    saiConnectId: ' 808675 ',
    lookupIdentifier: '808675',
    mobileNo: '9876543210',
  }), {
    saiConnectId: '808675',
    lookupIdentifier: '808675',
    mobileNo: '9876543210',
    hasCriteria: true,
    lockKeys: ['808675', '9876543210'],
  });

  assert.deepEqual(resolveSaiIdentityLookupCriteria({
    saiConnectId: null,
    lookupIdentifier: '9876543210',
    mobileNo: '9876543210',
  }), {
    saiConnectId: null,
    lookupIdentifier: '9876543210',
    mobileNo: '9876543210',
    hasCriteria: true,
    lockKeys: ['9876543210'],
  });

  assert.deepEqual(resolveSaiIdentityLookupCriteria({}), {
    saiConnectId: null,
    lookupIdentifier: null,
    mobileNo: null,
    hasCriteria: false,
    lockKeys: [],
  });
});

test('deallocating a delegate with an active caretaker is blocked unless both are deallocated together', () => {
  assert.throws(
    () => validateCaretakerDeallocationAllowed({
      targetIds: [101],
      activeCaretakers: [{ id: 202, caretaker_for_allocation_id: 101 }],
      batchMode: false,
    }),
    (error) => error instanceof AccommodationEligibilityError
      && error.code === 'delegate_has_caretaker'
      && error.message === 'Remove the linked caretaker before removing this Delegate.'
  );

  assert.throws(
    () => validateCaretakerDeallocationAllowed({
      targetIds: [101, 102],
      activeCaretakers: [{ id: 202, caretaker_for_allocation_id: 101 }],
      batchMode: true,
    }),
    (error) => error instanceof AccommodationEligibilityError
      && error.code === 'delegate_has_caretaker'
      && error.message === 'Include the linked caretaker when deallocating a Delegate.'
  );

  assert.doesNotThrow(() => validateCaretakerDeallocationAllowed({
    targetIds: [101, 202],
    activeCaretakers: [{ id: 202, caretaker_for_allocation_id: 101 }],
    batchMode: true,
  }));
});

test('caretaker stay dates cannot be edited independently of the linked delegate', () => {
  assert.throws(
    () => validateCaretakerDateEditAllowed({
      isCaretaker: true,
      currentStartDate: '2026-11-05',
      currentEndDate: '2026-11-24',
      nextEndDate: '2026-11-20',
    }),
    (error) => error instanceof AccommodationEligibilityError
      && error.code === 'caretaker_dates_locked'
      && error.message === 'Caretaker stay dates follow the linked Delegate and cannot be edited independently.'
  );

  assert.doesNotThrow(() => validateCaretakerDateEditAllowed({
    isCaretaker: true,
    currentStartDate: '2026-11-05',
    currentEndDate: '2026-11-24',
    nextStartDate: '2026-11-05',
    nextEndDate: '2026-11-24',
  }));

  assert.doesNotThrow(() => validateCaretakerDateEditAllowed({
    isCaretaker: false,
    currentStartDate: '2026-11-05',
    currentEndDate: '2026-11-24',
    nextEndDate: '2026-11-20',
  }));
});

test('admin editing an existing delegate without changing category succeeds, while downgrading a delegate with an active caretaker is blocked', () => {
  assert.equal(
    validateAdminCategoryChange('delegate', { currentCategory: 'delegate', hasActiveCaretaker: false }),
    'delegate'
  );
  assert.equal(
    validateAdminCategoryChange('delegate', { currentCategory: 'delegate', hasActiveCaretaker: true }),
    'delegate'
  );
  assert.equal(
    validateAdminCategoryChange('sevadal', { currentCategory: 'delegate', hasActiveCaretaker: false }),
    'sevadal'
  );
  assert.throws(
    () => validateAdminCategoryChange('sevadal', { currentCategory: 'delegate', hasActiveCaretaker: true }),
    (error) => error instanceof AccommodationEligibilityError
      && error.code === 'delegate_has_caretaker'
      && error.message === 'Remove the linked caretaker before changing this Delegate’s category.'
  );
  assert.throws(
    () => validateAdminCategoryChange('devotee', { currentCategory: 'delegate', hasActiveCaretaker: true }),
    (error) => error instanceof AccommodationEligibilityError
      && error.code === 'delegate_has_caretaker'
  );
});

test('local-midnight Date objects from pg DATE columns normalize without off-by-one timezone shifts', () => {
  const localMidnightDate = new Date(2026, 10, 15, 0, 0, 0, 0);
  const utcIsoDate = new Date('2026-11-15');
  assert.equal(normalizeDateString(localMidnightDate), '2026-11-15');
  assert.equal(normalizeDateString(utcIsoDate), '2026-11-15');
  assert.equal(normalizeDateString('2026-11-15'), '2026-11-15');

  assert.doesNotThrow(() => validateCaretakerDateEditAllowed({
    isCaretaker: true,
    currentStartDate: new Date(2026, 10, 15, 0, 0, 0, 0),
    currentEndDate: new Date(2026, 10, 20, 0, 0, 0, 0),
    nextStartDate: '2026-11-15',
    nextEndDate: '2026-11-20',
  }));
});

test('allocation date range validation accepts same-day and ordered ranges while rejecting reversed or malformed dates', () => {
  assert.equal(isValidIsoDateString('2026-11-15'), true);
  assert.equal(isValidIsoDateString('2026-02-31'), false);
  assert.equal(isValidIsoDateString('15-11-2026'), false);

  assert.deepEqual(
    validateAllocationDateRange({ startDate: '2026-11-15', endDate: '2026-11-15' }),
    { startDate: '2026-11-15', endDate: '2026-11-15' }
  );
  assert.deepEqual(
    validateAllocationDateRange({ startDate: '2026-11-15', endDate: '2026-11-20' }),
    { startDate: '2026-11-15', endDate: '2026-11-20' }
  );

  assert.throws(
    () => validateAllocationDateRange({ startDate: '2026-11-20', endDate: '2026-11-15' }),
    (error) => error instanceof AccommodationEligibilityError
      && error.code === 'invalid_date_range'
      && error.message === 'End date must be on or after start date.'
  );
  assert.throws(
    () => validateAllocationDateRange({ startDate: '2026-02-31', endDate: '2026-11-20' }),
    (error) => error instanceof AccommodationEligibilityError
      && error.code === 'invalid_date_range'
  );
});
