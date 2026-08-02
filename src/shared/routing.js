export const MAX_API_PROFILES = 20;

export function normalizeApiProfiles(profiles, fallback = {}) {
  const source = Array.isArray(profiles) && profiles.length ? profiles : [fallback];
  return source.slice(0, MAX_API_PROFILES).map((profile, index) => ({
    id: String(profile?.id || `profile-${index + 1}`),
    name: String(profile?.name || `API ${index + 1}`).trim() || `API ${index + 1}`,
    enabled: profile?.enabled !== false,
    provider: String(profile?.provider || fallback.provider || 'custom'),
    apiEndpoint: String(profile?.apiEndpoint || fallback.apiEndpoint || '').trim(),
    apiKey: String(profile?.apiKey || fallback.apiKey || '').trim(),
    apiModel: String(profile?.apiModel || fallback.apiModel || '').trim()
  }));
}

export function orderedEnabledProfiles(profiles, cursor = 0) {
  const enabled = profiles.filter(profile => profile.enabled);
  if (!enabled.length) return [];
  const start = ((Number(cursor) || 0) % enabled.length + enabled.length) % enabled.length;
  return [...enabled.slice(start), ...enabled.slice(0, start)];
}