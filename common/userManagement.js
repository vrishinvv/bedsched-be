import bcrypt from 'bcrypt';

export const USER_ROLES = Object.freeze(['admin', 'dashboard', 'location_user']);

const USERNAME_PATTERN = /^[A-Za-z0-9._-]+$/;
const BCRYPT_PATTERN = /^\$2[aby]\$/;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_BYTES = 72;
const PASSWORD_HASH_ROUNDS = 12;

export class UserValidationError extends Error {
  constructor(code, message, field) {
    super(message);
    this.name = 'UserValidationError';
    this.code = code;
    this.field = field;
  }
}

function fail(code, message, field) {
  throw new UserValidationError(code, message, field);
}

export function validateCreateUserInput(input = {}) {
  const candidate = input && typeof input === 'object' ? input : {};
  const username = typeof candidate.username === 'string' ? candidate.username.trim() : '';
  const password = typeof candidate.password === 'string' ? candidate.password : '';
  const role = typeof candidate.role === 'string' ? candidate.role.trim() : '';

  if (username.length < 3 || username.length > 50) {
    fail('invalid_username', 'Username must be between 3 and 50 characters.', 'username');
  }
  if (!USERNAME_PATTERN.test(username)) {
    fail(
      'invalid_username',
      'Username may only contain letters, numbers, periods, underscores, and hyphens.',
      'username'
    );
  }

  const passwordBytes = Buffer.byteLength(password, 'utf8');
  if (password.length < MIN_PASSWORD_LENGTH) {
    fail('invalid_password', `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`, 'password');
  }
  if (passwordBytes > MAX_PASSWORD_BYTES) {
    fail('invalid_password', `Password must be at most ${MAX_PASSWORD_BYTES} bytes.`, 'password');
  }

  if (!USER_ROLES.includes(role)) {
    fail('invalid_role', 'Select a valid account role.', 'role');
  }

  const rawLocationId = candidate.locationId;
  const hasLocationId = rawLocationId !== undefined && rawLocationId !== null && rawLocationId !== '';
  const locationId = hasLocationId ? Number(rawLocationId) : null;

  if (role === 'location_user') {
    if (!Number.isSafeInteger(locationId) || locationId <= 0) {
      fail('location_required', 'A location is required for a location user.', 'locationId');
    }
  } else if (hasLocationId) {
    fail('location_not_allowed', 'Only location users can be assigned to a location.', 'locationId');
  }

  return {
    username,
    password,
    role,
    locationId: role === 'location_user' ? locationId : null,
  };
}

export function isPasswordHash(value) {
  return typeof value === 'string' && BCRYPT_PATTERN.test(value);
}

export async function hashPassword(password) {
  return bcrypt.hash(password, PASSWORD_HASH_ROUNDS);
}

export async function verifyPassword(password, storedPassword) {
  if (typeof password !== 'string' || typeof storedPassword !== 'string') return false;
  if (isPasswordHash(storedPassword)) return bcrypt.compare(password, storedPassword);
  return storedPassword === password;
}
