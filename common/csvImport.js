import { parse } from 'csv-parse/sync';
import { isValidIsoDateString } from './accommodationEligibility.js';

export function parseCsvContent(csvContent) {
  return parse(csvContent, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
  });
}

export function validateCsvAllocationRow(row = {}, { genderRestriction = 'both' } = {}) {
  const name = row['Name']?.trim();
  const gender = row['Gender']?.trim();
  const phone = row['Phone']?.trim();
  const emergencyPhone = row['Emergency Phone']?.trim() || null;
  const startDate = row['Start date']?.trim();
  const endDate = row['End date']?.trim();

  if (!name) throw new Error('Name is required');
  if (!phone) throw new Error('Phone is required');
  if (!startDate) throw new Error('Start date is required');
  if (!endDate) throw new Error('End date is required');
  if (!isValidIsoDateString(startDate)) throw new Error('Start date must be a valid YYYY-MM-DD date');
  if (!isValidIsoDateString(endDate)) throw new Error('End date must be a valid YYYY-MM-DD date');
  if (startDate > endDate) throw new Error('End date must be on or after start date');

  const validGenders = ['Male', 'Female', 'Other'];
  const normalizedGender = validGenders.find((g) => g.toLowerCase() === gender?.toLowerCase()) || 'Other';

  if (genderRestriction === 'male_only' && normalizedGender.toLowerCase() !== 'male') {
    throw new Error('Block is male-only');
  }
  if (genderRestriction === 'female_only' && normalizedGender.toLowerCase() !== 'female') {
    throw new Error('Block is female-only');
  }

  return {
    name,
    phone,
    emergencyPhone,
    gender: normalizedGender,
    startDate,
    endDate,
  };
}
