const ANALYTICS_ROLES = new Set(['admin', 'dashboard']);

export function canViewAnalytics(user) {
  return ANALYTICS_ROLES.has(user?.role);
}

export function canViewRoomStatus(user) {
  return canViewAnalytics(user) || user?.role === 'location_user';
}

export function isDashboardApiRequestAllowed(method, path) {
  const isAnalyticsStructureLookup = method === 'GET' && (
    /^\/api\/locations\/\d+\/tents$/.test(path) ||
    /^\/api\/locations\/\d+\/tents\/\d+\/blocks$/.test(path)
  );

  return (
    (method === 'GET' && path === '/api/locations') ||
    (method === 'POST' && path === '/api/allocations/smart-reserve') ||
    (method === 'GET' && path === '/api/admin/analytics') ||
    (method === 'GET' && path === '/api/room-status') ||
    isAnalyticsStructureLookup
  );
}
