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

/**
 * Reorders already-enabled profiles fastest-first using an exponential moving average of
 * past response times. Profiles with no recorded latency keep their relative order at the
 * front so a new profile is tried before a known-slow one, and a profile that just failed
 * is still present (failover) but sorted behind healthy fast ones by the caller.
 */
export function orderByLatency(profiles, latencyStats = {}) {
  const keyed = profiles.map((profile, index) => ({
    profile,
    index,
    latency: Number(latencyStats[profile.id]?.ema) || 0
  }));
  const unknown = keyed.filter(entry => !entry.latency);
  const known = keyed.filter(entry => entry.latency).sort((a, b) => a.latency - b.latency || a.index - b.index);
  return [...unknown, ...known].map(entry => entry.profile);
}

/**
 * Folding a fresh sample into the EMA. alpha weights recent measurements so a provider
 * that degrades or recovers is reflected within a few requests rather than never.
 */
export function updateLatencyEma(previousEma, sampleMs, alpha = 0.4) {
  const sample = Math.max(0, Number(sampleMs) || 0);
  const previous = Number(previousEma) || 0;
  return previous ? previous + alpha * (sample - previous) : sample;
}