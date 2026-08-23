import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveMaxTokens, retryDelay } from '../src/shared/request-policy.js';

test('image requests receive a larger fixed output budget', () => {
  assert.equal(resolveMaxTokens([{ content: [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,x' } }] }]), 4096);
});

test('text request budgets are bounded by provider-safe limits', () => {
  assert.equal(resolveMaxTokens([{ content: 'short' }]), 2048);
  assert.equal(resolveMaxTokens([{ content: 'x'.repeat(20_000) }]), 8192);
});

test('retry delay honors numeric Retry-After values', () => {
  const response = { headers: new Headers({ 'retry-after': '3' }) };
  assert.equal(retryDelay(0, response, 0, 0), 3000);
});

test('retry delay honors HTTP dates and caps long waits', () => {
  const now = Date.parse('2026-08-23T00:00:00Z');
  const response = { headers: new Headers({ 'retry-after': 'Sun, 23 Aug 2026 00:01:00 GMT' }) };
  assert.equal(retryDelay(0, response, now, 0), 30_000);
});

test('retry delay applies capped exponential backoff', () => {
  assert.equal(retryDelay(0, undefined, 0, 0), 1000);
  assert.equal(retryDelay(10, undefined, 0, 0), 16_000);
});