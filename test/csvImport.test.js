import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCsvContent, validateCsvAllocationRow } from '../common/csvImport.js';

test('parses the allocation CSV format after the csv-parse security upgrade', () => {
  const records = parseCsvContent([
    '\uFEFFName,Gender,Phone,Emergency Phone,Start date,End date',
    '  Sai Ram  , Female ,9876543210,9123456780,2026-11-05,2026-11-24',
    '',
  ].join('\n'));

  assert.deepEqual(records, [{
    Name: 'Sai Ram',
    Gender: 'Female',
    Phone: '9876543210',
    'Emergency Phone': '9123456780',
    'Start date': '2026-11-05',
    'End date': '2026-11-24',
  }]);
});

test('rejects malformed CSV instead of returning partial rows', () => {
  assert.throws(
    () => parseCsvContent('Name,Phone\n"unterminated,123'),
    (error) => error?.code === 'CSV_QUOTE_NOT_CLOSED'
  );
});

test('validates CSV rows per-row including ISO date format, date ordering, and block gender restrictions', () => {
  assert.deepEqual(
    validateCsvAllocationRow({
      Name: '  Sai Ram  ',
      Gender: 'male',
      Phone: '9876543210',
      'Emergency Phone': '9123456780',
      'Start date': '2026-11-15',
      'End date': '2026-11-20',
    }, { genderRestriction: 'male_only' }),
    {
      name: 'Sai Ram',
      phone: '9876543210',
      emergencyPhone: '9123456780',
      gender: 'Male',
      startDate: '2026-11-15',
      endDate: '2026-11-20',
    }
  );

  assert.throws(
    () => validateCsvAllocationRow({
      Name: 'Bad Dates',
      Gender: 'Male',
      Phone: '9876543210',
      'Start date': '2026-11-22',
      'End date': '2026-11-15',
    }),
    /End date must be on or after start date/
  );

  assert.throws(
    () => validateCsvAllocationRow({
      Name: 'Malformed Date',
      Gender: 'Male',
      Phone: '9876543210',
      'Start date': '2026-02-30',
      'End date': '2026-11-15',
    }),
    /Start date must be a valid YYYY-MM-DD date/
  );

  assert.throws(
    () => validateCsvAllocationRow({
      Name: 'Wrong Gender',
      Gender: 'Female',
      Phone: '9876543210',
      'Start date': '2026-11-15',
      'End date': '2026-11-20',
    }, { genderRestriction: 'male_only' }),
    /Block is male-only/
  );
});
