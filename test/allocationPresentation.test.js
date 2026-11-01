import assert from 'node:assert/strict';
import test from 'node:test';

import { mapAllocationRowToBedData } from '../common/allocationPresentation.js';

test('occupied-bed data exposes the saved Sai Connect profile as read-only display fields', () => {
  assert.deepEqual(mapAllocationRowToBedData({
    id: 101,
    name: 'Verified Delegate',
    phone: '9876543210',
    emergency_phone: null,
    gender: 'Male',
    start_date_str: '2026-11-05',
    end_date_str: '2026-11-24',
    status: 'confirmed',
    reserved_expires_at: null,
    created_at: null,
    accommodation_category: 'delegate',
    category_source: 'sai_connect',
    verified_categories: ['delegate'],
    sai_connect_id: '808675',
    sai_connect_age: 35,
    caretaker_for_allocation_id: null,
    caretaker_for_name: null,
  }), {
    id: 101,
    name: 'Verified Delegate',
    phone: '9876543210',
    emergencyPhone: null,
    gender: 'Male',
    startDate: '2026-11-05',
    endDate: '2026-11-24',
    status: 'confirmed',
    reservedExpiresAt: null,
    createdAt: null,
    accommodationCategory: 'delegate',
    categorySource: 'sai_connect',
    verifiedCategories: ['delegate'],
    saiConnectId: '808675',
    saiConnectAge: 35,
    caretakerForAllocationId: null,
    caretakerForName: null,
  });
});
