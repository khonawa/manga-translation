import test from 'node:test';
import assert from 'node:assert/strict';

import { MAX_API_PROFILES, normalizeApiProfiles, orderedEnabledProfiles } from '../src/shared/routing.js';

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