import jwt from 'jsonwebtoken';

const AUTH_ISSUER = 'bedsched-be';
const AUTH_AUDIENCE = 'bedsched-fe';
const AUTH_ALGORITHM = 'HS256';
const AUTH_ROLES = new Set(['admin', 'dashboard', 'location_user']);

function normalizeUser(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (!payload.username || !AUTH_ROLES.has(payload.role)) return null;

  const id = payload.id == null ? null : Number(payload.id);
  const locationId = payload.locationId == null ? null : Number(payload.locationId);

  return {
    username: payload.username,
    role: payload.role,
    id: Number.isFinite(id) ? id : null,
    locationId: Number.isFinite(locationId) ? locationId : null,
  };
}

export function createAuthToken(user, secret) {
  if (!secret) throw new Error('JWT_SECRET is required');

  return jwt.sign(
    {
      id: user.id,
      username: user.username,
      role: user.role,
      locationId: user.locationId ?? user.location_id ?? null,
    },
    secret,
    {
      algorithm: AUTH_ALGORITHM,
      audience: AUTH_AUDIENCE,
      issuer: AUTH_ISSUER,
      expiresIn: '7d',
    },
  );
}

export function verifyAuthToken(token, secret) {
  if (!token || !secret) return null;

  try {
    const payload = jwt.verify(token, secret, {
      algorithms: [AUTH_ALGORITHM],
      audience: AUTH_AUDIENCE,
      issuer: AUTH_ISSUER,
    });
    return normalizeUser(payload);
  } catch {
    return null;
  }
}

export function getUserFromRequest(req, secret) {
  const authHeader = req.headers?.authorization ?? req.headers?.Authorization;
  if (typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
    return null;
  }

  return verifyAuthToken(authHeader.slice('Bearer '.length).trim(), secret);
}
