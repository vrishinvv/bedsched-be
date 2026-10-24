export const BLOCK_TYPES = Object.freeze(['both', 'male_only', 'female_only']);

const MAX_NAME_LENGTH = 100;
const MAX_BLOCK_SIZE = 10000;

export class StructureValidationError extends Error {
  constructor(code, message, field) {
    super(message);
    this.name = 'StructureValidationError';
    this.code = code;
    this.field = field;
  }
}

function fail(code, message, field) {
  throw new StructureValidationError(code, message, field);
}

export function validateEntityId(value, field = 'id') {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    fail('invalid_id', 'A valid entity ID is required.', field);
  }
  return id;
}

export function validateStructureName(value, field, label) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name) fail('name_required', `${label} name is required.`, field);
  if (name.length > MAX_NAME_LENGTH) {
    fail('name_too_long', `${label} name must be ${MAX_NAME_LENGTH} characters or fewer.`, field);
  }
  return name;
}

export function validateBlockSize(value) {
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_BLOCK_SIZE) {
    fail('invalid_block_size', `Block size must be a whole number between 1 and ${MAX_BLOCK_SIZE}.`, 'size');
  }
  return size;
}

export function validateBlockType(value) {
  if (!BLOCK_TYPES.includes(value)) {
    fail('invalid_block_type', 'Select a valid block type.', 'genderRestriction');
  }
  return value;
}

export function validateCreateTentInput(input) {
  const candidate = input && typeof input === 'object' ? input : {};
  return { name: validateStructureName(candidate.name, 'name', 'Tent') };
}

export function validateCreateBlockInput(input) {
  const candidate = input && typeof input === 'object' ? input : {};
  return {
    name: validateStructureName(candidate.name, 'name', 'Block'),
    size: validateBlockSize(candidate.size),
    genderRestriction: validateBlockType(candidate.genderRestriction || 'both'),
  };
}

export function validateBlockUpdateInput(input) {
  const candidate = input && typeof input === 'object' ? input : {};
  const update = {};

  if (Object.hasOwn(candidate, 'name')) {
    update.name = validateStructureName(candidate.name, 'name', 'Block');
  }
  if (Object.hasOwn(candidate, 'size')) {
    update.size = validateBlockSize(candidate.size);
  }
  if (Object.hasOwn(candidate, 'genderRestriction')) {
    update.genderRestriction = validateBlockType(candidate.genderRestriction);
  }

  if (Object.keys(update).length === 0) {
    fail('no_changes', 'Provide at least one block field to update.', 'form');
  }
  return update;
}
