export function isSeedAllowed(nodeEnv) {
  return nodeEnv !== 'production';
}

export function isCronAuthorized(nodeEnv, authorizationHeader, cronSecret) {
  if (nodeEnv !== 'production') return true;
  return Boolean(cronSecret) && authorizationHeader === `Bearer ${cronSecret}`;
}
