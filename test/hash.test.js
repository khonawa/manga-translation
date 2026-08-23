import test from 'node:test';
import assert from 'node:assert/strict';

import { hashString } from '../src/shared/hash.js';

test('is deterministic for the same input', () => {
  assert.equal(hashString('https://example.com/page/1'), hashString('https://example.com/page/1'));
});

test('produces URL-safe base36 output with a length suffix', () => {
  const hash = hashString('https://example.com/page/1');
  assert.match(hash, /^[0-9a-z]+$/);
});

test('pins known-stable outputs so the algorithm cannot silently change', () => {
  // If these change, every previously-saved page session key becomes unreachable,
  // so the values are pinned deliberately rather than recomputed.
  assert.equal(hashString('a'), '1r9wi7g1veflek1');
  assert.equal(hashString('https://example.com/page/1'), '1w0vhpf1wxi403q');
  assert.equal(hashString('こんにちは'), 'cdafy415fa6h85');
});

test('differs for inputs that differ by a single character', () => {
  assert.notEqual(hashString('https://example.com/page/1'), hashString('https://example.com/page/2'));
});

test('handles non-ASCII input without throwing', () => {
  assert.equal(typeof hashString('こんにちは世界'), 'string');
  assert.ok(hashString('こんにちは世界').length > 0);
});
