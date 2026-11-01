import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AccommodationEligibilityError,
  resolveMandatoryLookupCategory,
  resolveVerifiedCategory,
  resolveUnverifiedCategory,
  validateAdminCategoryChange,
  validateCategoryAllowedInBlock,
  validateBulkSaiIdentityAbsent,
  validateCaretakerTarget,
  validateSaiIdentityAvailable,
} from '../common/accommodationEligibility.js';

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

test('a caretaker remains exempt from Sai Connect lookup', () => {
  assert.deepEqual(
    resolveMandatoryLookupCategory({ verification: null, isCaretaker: true }),
    {
      accommodationCategory: 'devotee',
      categorySource: 'default',
      verifiedCategories: [],
    }
  );
});

test('a Sai Connect identity can have only one active allocation while caretakers remain exempt', () => {
  assert.throws(
    () => validateSaiIdentityAvailable({
      identifier: '239910',
      existingAllocationId: 81,
    }),
    (error) => error instanceof AccommodationEligibilityError
      && error.code === 'sai_connect_already_allocated'
  );

  assert.doesNotThrow(() => validateSaiIdentityAvailable({
    identifier: null,
    existingAllocationId: 81,
    isCaretaker: true,
  }));
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
