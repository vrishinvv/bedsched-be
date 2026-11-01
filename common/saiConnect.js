import http from 'node:http';
import https from 'node:https';
import jwt from 'jsonwebtoken';

import { ACCOMMODATION_CATEGORIES } from './accommodationEligibility.js';

const TOKEN_AUDIENCE = 'bedsched-fe';
const TOKEN_ISSUER = 'bedsched-sai-connect';

export class SaiConnectError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SaiConnectError';
    this.code = code;
  }
}

function normalizedParticipantId(identifier) {
  const value = String(identifier ?? '').trim();
  if (!/^\d{1,15}$/.test(value)) {
    throw new SaiConnectError('invalid_identifier', 'Enter a valid Sai Connect ID or phone number.');
  }
  const numeric = Number(value);
  return value.startsWith('0') || !Number.isSafeInteger(numeric) ? value : numeric;
}

function requestJson({ endpoint, bearerToken, payload, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint);
    const transport = url.protocol === 'http:' ? http : https;
    const body = JSON.stringify(payload);
    const request = transport.request(url, {
      method: 'GET',
      timeout: timeoutMs,
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (response) => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { raw += chunk; });
      response.on('end', () => {
        let data;
        try {
          data = JSON.parse(raw);
        } catch {
          reject(new SaiConnectError('invalid_response', 'Sai Connect returned an unreadable response.'));
          return;
        }
        resolve({ statusCode: response.statusCode || 500, data });
      });
    });

    request.on('timeout', () => request.destroy(new SaiConnectError('timeout', 'Sai Connect lookup timed out.')));
    request.on('error', (error) => {
      reject(error instanceof SaiConnectError
        ? error
        : new SaiConnectError('unavailable', 'Sai Connect is temporarily unavailable.'));
    });
    request.end(body);
  });
}

function errorOutcome(message, identifier) {
  const normalizedMessage = typeof message === 'string' ? message : 'Sai Connect lookup failed.';
  if (/not registered/i.test(normalizedMessage)) {
    return { outcome: 'not_registered', identifier, message: normalizedMessage };
  }
  if (/not approved/i.test(normalizedMessage)) {
    return { outcome: 'not_approved', identifier, message: normalizedMessage };
  }
  if (/invalid/i.test(normalizedMessage)) {
    return { outcome: 'invalid', identifier, message: normalizedMessage };
  }
  return { outcome: 'error', identifier, message: normalizedMessage };
}

export async function lookupSaiConnectMember({
  endpoint,
  bearerToken,
  identifier,
  eventCategoryMap,
  timeoutMs = 8000,
}) {
  if (!endpoint || !bearerToken) {
    throw new SaiConnectError('not_configured', 'Sai Connect is not configured.');
  }

  const normalizedIdentifier = String(identifier ?? '').trim();
  const participantId = normalizedParticipantId(normalizedIdentifier);
  const eventIds = [...eventCategoryMap.keys()].map(Number);
  const response = await requestJson({
    endpoint,
    bearerToken,
    timeoutMs,
    payload: { Participant_id: participantId, event_ids: eventIds },
  });

  if (response.data?.status !== 'success' || !response.data?.data) {
    return errorOutcome(response.data?.message, normalizedIdentifier);
  }

  const registrations = (Array.isArray(response.data.data.checkin_status)
    ? response.data.data.checkin_status
    : [])
    .map((registration) => {
      const eventId = Number(registration.event_id);
      const category = eventCategoryMap.get(eventId);
      if (!category) return null;
      return {
        eventId,
        eventName: registration.event_name || '',
        checkedIn: Boolean(registration.checked_in),
        category,
      };
    })
    .filter(Boolean);

  const categorySet = new Set(registrations.map(({ category }) => category));
  const verifiedCategories = ACCOMMODATION_CATEGORIES.filter((category) => categorySet.has(category));
  if (verifiedCategories.length === 0) {
    return {
      outcome: 'not_registered',
      identifier: normalizedIdentifier,
      message: 'Participant not registered.',
    };
  }

  return {
    outcome: 'matched',
    identifier: normalizedIdentifier,
    fullName: response.data.data.full_name || '',
    age: response.data.data.age ?? null,
    mobileNo: response.data.data.mobile_no ?? null,
    verifiedCategories,
    registrations,
  };
}

export function createSaiVerificationToken(result, secret) {
  return jwt.sign({
    type: 'sai_connect_verification',
    outcome: result.outcome,
    identifier: result.identifier,
    fullName: result.fullName,
    verifiedCategories: result.verifiedCategories,
  }, secret, {
    algorithm: 'HS256',
    audience: TOKEN_AUDIENCE,
    issuer: TOKEN_ISSUER,
    expiresIn: '10m',
  });
}

export function verifySaiVerificationToken(token, secret) {
  try {
    const payload = jwt.verify(token, secret, {
      algorithms: ['HS256'],
      audience: TOKEN_AUDIENCE,
      issuer: TOKEN_ISSUER,
    });
    if (payload.type !== 'sai_connect_verification') throw new Error('wrong token type');
    const outcome = ['matched', 'not_registered', 'not_approved', 'invalid', 'error'].includes(payload.outcome)
      ? payload.outcome
      : undefined;
    return {
      ...(outcome ? { outcome } : {}),
      identifier: String(payload.identifier),
      fullName: String(payload.fullName || ''),
      verifiedCategories: ACCOMMODATION_CATEGORIES.filter((category) => (
        Array.isArray(payload.verifiedCategories) && payload.verifiedCategories.includes(category)
      )),
    };
  } catch {
    throw new SaiConnectError('invalid_verification', 'Invalid Sai Connect verification. Please look up the person again.');
  }
}
