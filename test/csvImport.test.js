import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCsvContent } from '../common/csvImport.js';

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
