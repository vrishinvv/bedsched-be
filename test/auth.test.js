import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

import { createAuthToken, getUserFromRequest, verifyAuthToken } from '../common/auth.js';

const secret = 'test-secret-that-is-long-and-random-enough-for-hmac';

test('accepts a valid signed bearer token', () => {
  const token = createAuthToken(
    { id: 7, username: 'admin', role: 'admin', locationId: null },
    secret,
  );

  assert.deepEqual(
    getUserFromRequest({ headers: { authorization: `Bearer ${token}` } }, secret),
    { id: 7, username: 'admin', role: 'admin', locationId: null },
  );
});

test('does not trust legacy unsigned identity cookies', () => {
  const request = {
    headers: {},
    cookies: {
      bs_user: 'admin',
      bs_role: 'admin',
      bs_user_id: '1',
    },
  };

  assert.equal(getUserFromRequest(request, secret), null);
});

test('rejects tampered, expired, and legacy-format tokens', () => {
  const validToken = createAuthToken(
    { id: 4, username: 'sse_1', role: 'location_user', locationId: 61 },
    secret,
  );
  const tamperedToken = `${validToken.slice(0, -1)}${validToken.endsWith('a') ? 'b' : 'a'}`;
  const expiredToken = jwt.sign(
    { id: 4, username: 'sse_1', role: 'location_user', locationId: 61 },
    secret,
    { algorithm: 'HS256', audience: 'bedsched-fe', issuer: 'bedsched-be', expiresIn: -1 },
  );
  const legacyToken = jwt.sign(
    { id: 4, username: 'sse_1', role: 'location_user', locationId: 61 },
    secret,
    { expiresIn: '1h' },
  );

  assert.equal(verifyAuthToken(tamperedToken, secret), null);
  assert.equal(verifyAuthToken(expiredToken, secret), null);
  assert.equal(verifyAuthToken(legacyToken, secret), null);
});

test('rejects signed tokens with an unsupported role', () => {
  const token = jwt.sign(
    { id: 9, username: 'attacker', role: 'superadmin' },
    secret,
    { algorithm: 'HS256', audience: 'bedsched-fe', issuer: 'bedsched-be', expiresIn: '1h' },
  );

  assert.equal(verifyAuthToken(token, secret), null);
});

