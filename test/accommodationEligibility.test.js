import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AccommodationEligibilityError,
  resolveMandatoryLookupCategory,
  resolveAllocationGender,
  resolveSaiIdentityPersistence,
  resolveSaiProfileForAllocation,
  resolveVerifiedCategory,
  resolveUnverifiedCategory,
  validateAdminCategoryChange,
  validateAccommodationCategoryEditPermission,
  validateCategoryAllowedInBlock,
  validateBulkSaiIdentityAbsent,
  validateCaretakerTarget,
  validateGenderAllowedInBlock,
  validateSaiIdentityAvailable,
  validateSaiProfileEditPermission,
} from '../common/accommodationEligibility.js';

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
