export function resolveDatabaseSsl(connectionString) {
  if (!connectionString) return false;
  try {
    const { hostname } = new URL(connectionString);
    if (!hostname || hostname === 'localhost' || hostname === '127.0.0.1') return false;
  } catch {
    return false;
  }
  return { rejectUnauthorized: false };
}
