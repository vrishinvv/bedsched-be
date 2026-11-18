function normalizeLocationId(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function normalizeLocationIds(values = []) {
  const source = Array.isArray(values) ? values : [values];
  return Array.from(new Set(source.map(normalizeLocationId).filter(Boolean))).sort((a, b) => a - b);
}

export function getAccessibleLocationIds(user) {
  if (user?.role !== 'location_user') return [];
  return normalizeLocationIds([
    ...(Array.isArray(user.locationIds) ? user.locationIds : []),
    user.locationId,
  ]);
}

export function canAccessLocation(user, locationId) {
  if (user?.role === 'admin') return true;
  const requested = normalizeLocationId(locationId);
  return requested !== null && getAccessibleLocationIds(user).includes(requested);
}

/**
 * Resolves an optional requested location into a safe SQL scope.
 * `locationIds: null` means an administrator is intentionally unscoped.
 */
export function resolveLocationAccessScope(user, requestedLocationId = null) {
  const requested = requestedLocationId === '' || requestedLocationId == null
    ? null
    : normalizeLocationId(requestedLocationId);

  if (requestedLocationId !== '' && requestedLocationId != null && requested === null) {
    return { forbidden: true, locationIds: [] };
  }

  if (user?.role === 'admin') {
    return { forbidden: false, locationIds: requested === null ? null : [requested] };
  }

  if (user?.role !== 'location_user') {
    return { forbidden: true, locationIds: [] };
  }

  const accessible = getAccessibleLocationIds(user);
  if (requested !== null) {
    return accessible.includes(requested)
      ? { forbidden: false, locationIds: [requested] }
      : { forbidden: true, locationIds: [] };
  }

  return {
    forbidden: accessible.length === 0,
    locationIds: accessible,
  };
}
