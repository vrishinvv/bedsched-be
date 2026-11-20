export const MAX_ROOM_STATE_OPTION_NAME_LENGTH = 100;

export class RoomStateAssignmentError extends Error {
  constructor(code, message, field = 'stateOptionId') {
    super(message);
    this.name = 'RoomStateAssignmentError';
    this.code = code;
    this.field = field;
  }
}

export function normalizeRoomStateOptionId(value, { allowEmpty = false } = {}) {
  if ((value === null || value === undefined || value === '') && allowEmpty) return null;
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new RoomStateAssignmentError(
      'invalid_state_option',
      'Select a valid allocated-state option.',
    );
  }
  return id;
}

export function normalizeRoomStateOptionName(value) {
  const name = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (!name) {
    throw new RoomStateAssignmentError(
      'invalid_state_option_name',
      'Enter an option name.',
      'name',
    );
  }
  if (name.length > MAX_ROOM_STATE_OPTION_NAME_LENGTH) {
    throw new RoomStateAssignmentError(
      'invalid_state_option_name',
      `Option names must be ${MAX_ROOM_STATE_OPTION_NAME_LENGTH} characters or fewer.`,
      'name',
    );
  }
  return name;
}
