import { parse } from 'csv-parse/sync';

export function parseCsvContent(csvContent) {
  return parse(csvContent, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
  });
}
