export const INDIAN_STATES = Object.freeze([
  { code: 'AP', name: 'Andhra Pradesh' },
  { code: 'AR', name: 'Arunachal Pradesh' },
  { code: 'AS', name: 'Assam' },
  { code: 'BR', name: 'Bihar' },
  { code: 'CG', name: 'Chhattisgarh' },
  { code: 'GA', name: 'Goa' },
  { code: 'GJ', name: 'Gujarat' },
  { code: 'HR', name: 'Haryana' },
  { code: 'HP', name: 'Himachal Pradesh' },
  { code: 'JH', name: 'Jharkhand' },
  { code: 'KA', name: 'Karnataka' },
  { code: 'KL', name: 'Kerala' },
  { code: 'MP', name: 'Madhya Pradesh' },
  { code: 'MH', name: 'Maharashtra' },
  { code: 'MN', name: 'Manipur' },
  { code: 'ML', name: 'Meghalaya' },
  { code: 'MZ', name: 'Mizoram' },
  { code: 'NL', name: 'Nagaland' },
  { code: 'OD', name: 'Odisha' },
  { code: 'PB', name: 'Punjab' },
  { code: 'RJ', name: 'Rajasthan' },
  { code: 'SK', name: 'Sikkim' },
  { code: 'TN', name: 'Tamil Nadu' },
  { code: 'TS', name: 'Telangana' },
  { code: 'TR', name: 'Tripura' },
  { code: 'UP', name: 'Uttar Pradesh' },
  { code: 'UK', name: 'Uttarakhand' },
  { code: 'WB', name: 'West Bengal' },
]);

const STATE_BY_CODE = new Map(INDIAN_STATES.map((state) => [state.code, state]));

export class RoomStateAssignmentError extends Error {
  constructor(code, message, field = 'stateCode') {
    super(message);
    this.name = 'RoomStateAssignmentError';
    this.code = code;
    this.field = field;
  }
}

export function normalizeIndianStateCode(value, { allowEmpty = false } = {}) {
  const code = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!code && allowEmpty) return null;
  if (!STATE_BY_CODE.has(code)) {
    throw new RoomStateAssignmentError(
      'invalid_state',
      'Select one of the 28 Indian states.',
    );
  }
  return code;
}

export function getIndianState(code) {
  return STATE_BY_CODE.get(code) || null;
}
