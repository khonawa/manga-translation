import test from 'node:test';
import assert from 'node:assert/strict';

import { MAX_API_PROFILES, normalizeApiProfiles, orderedEnabledProfiles, orderByLatency, updateLatencyEma } from '../src/shared/routing.js';

test('legacy API settings become the first enabled profile', () => {
  const [profile] = normalizeApiProfiles(undefined, {
    provider: 'gemini', apiEndpoint: 'https://example.com/v1', apiKey: 'key', apiModel: 'gemini-flash'
  });
  assert.equal(profile.enabled, true);
  assert.equal(profile.provider, 'gemini');
  assert.equal(profile.apiModel, 'gemini-flash');
});

test('round robin skips disabled profiles and wraps', () => {
  const profiles = [
    { id: 'one', enabled: true },
    { id: 'two', enabled: false },
    { id: 'three', enabled: true }
  ];
  assert.deepEqual(orderedEnabledProfiles(profiles, 1).map(profile => profile.id), ['three', 'one']);
  assert.deepEqual(orderedEnabledProfiles(profiles, 2).map(profile => profile.id), ['one', 'three']);
});

test('profile storage is capped at the supported UI size', () => {
  const profiles = normalizeApiProfiles(Array.from({ length: MAX_API_PROFILES + 3 }, (_, index) => ({ name: `API ${index}` })));
  assert.equal(profiles.length, MAX_API_PROFILES);
});

test('latency ordering puts measured-fast profiles first and unmeasured ahead of slow', () => {
  const profiles = [{ id: 'slow' }, { id: 'fast' }, { id: 'new' }];
  const stats = { slow: { ema: 5000 }, fast: { ema: 800 } };
  assert.deepEqual(orderByLatency(profiles, stats).map(profile => profile.id), ['new', 'fast', 'slow']);
});

test('latency EMA seeds from the first sample and blends later ones', () => {
  assert.equal(updateLatencyEma(0, 1000), 1000);
  assert.equal(updateLatencyEma(1000, 2000, 0.5), 1500);
});