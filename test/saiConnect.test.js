import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import {
  createSaiVerificationToken,
  lookupSaiConnectMember,
  verifySaiVerificationToken,
} from '../common/saiConnect.js';

const eventCategoryMap = new Map([
  [14, 'sevadal'],
  [15, 'delegate'],
]);

async function withServer(handler, operation) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await operation(`http://127.0.0.1:${port}/lookup`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test('calls Sai Connect with a bearer-authenticated GET JSON body and maps returned events', async () => {
  let received;
  const result = await withServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    received = {
      method: req.method,
      authorization: req.headers.authorization,
      contentType: req.headers['content-type'],
      body: JSON.parse(body),
    };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      status: 'success',
      data: {
        full_name: 'Ramesh Kumar',
        age: 35,
        mobile_no: null,
        gender: 'male',
        checkin_status: [
          { event_id: 14, event_name: 'Sevadal Conference', checked_in: false },
          { event_id: 15, event_name: 'Delegate Conference', checked_in: true },
        ],
      },
    }));
  }, (endpoint) => lookupSaiConnectMember({
    endpoint,
    bearerToken: 'test-token',
    identifier: '427199',
    eventCategoryMap,
  }));

  assert.deepEqual(received, {
    method: 'GET',
    authorization: 'Bearer test-token',
    contentType: 'application/json',
    body: { Participant_id: 427199, event_ids: [14, 15] },
  });
  assert.deepEqual(result, {
    outcome: 'matched',
    identifier: '427199',
    fullName: 'Ramesh Kumar',
    age: 35,
    mobileNo: null,
    gender: 'Male',
    verifiedCategories: ['delegate', 'sevadal'],
    registrations: [
      { eventId: 14, eventName: 'Sevadal Conference', checkedIn: false, category: 'sevadal' },
      { eventId: 15, eventName: 'Delegate Conference', checkedIn: true, category: 'delegate' },
    ],
  });
});

test('treats a valid participant without requested registrations as not registered', async () => {
  const result = await withServer((_req, res) => {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'error', data: null, message: 'Participant not registered.' }));
  }, (endpoint) => lookupSaiConnectMember({
    endpoint,
    bearerToken: 'test-token',
    identifier: '427199',
    eventCategoryMap,
  }));

  assert.deepEqual(result, {
    outcome: 'not_registered',
    identifier: '427199',
    message: 'Participant not registered.',
  });
});

test('issues a short-lived signed verification token that preserves both categories', () => {
  const secret = 'test-secret-that-is-long-and-random-enough-for-hmac';
  const token = createSaiVerificationToken({
    identifier: '427199',
    fullName: 'Ramesh Kumar',
    gender: 'Female',
    verifiedCategories: ['delegate', 'sevadal'],
  }, secret);

  assert.deepEqual(verifySaiVerificationToken(token, secret), {
    identifier: '427199',
    fullName: 'Ramesh Kumar',
    gender: 'Female',
    verifiedCategories: ['delegate', 'sevadal'],
  });
  assert.throws(() => verifySaiVerificationToken(`${token}tampered`, secret), /Invalid Sai Connect verification/);
});

test('issues lookup proof when Sai Connect finds no registration', () => {
  const secret = 'test-secret-that-is-long-and-random-enough-for-hmac';
  const token = createSaiVerificationToken({
    outcome: 'not_registered',
    identifier: '999999',
    verifiedCategories: [],
  }, secret);

  assert.deepEqual(verifySaiVerificationToken(token, secret), {
    outcome: 'not_registered',
    identifier: '999999',
    fullName: '',
    verifiedCategories: [],
  });
});
