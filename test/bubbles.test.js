import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeBubble, normalizeBubbles, overlapRatio, rectsSubstantiallyOverlap, MAX_BUBBLES } from '../src/shared/bubbles.js';

test('accepts a well-formed bubble', () => {
  const bubble = normalizeBubble({ box_2d: [10, 20, 100, 200], english: 'Hello', source: 'こんにちは' });
  assert.deepEqual(bubble, { box_2d: [10, 20, 100, 200], source: 'こんにちは', english: 'Hello' });
});

test('rejects a bubble with no box', () => {
  assert.equal(normalizeBubble({ english: 'Hello' }), null);
});

test('rejects a box with the wrong number of coordinates', () => {
  assert.equal(normalizeBubble({ box_2d: [1, 2, 3], english: 'Hello' }), null);
});

test('rejects non-numeric coordinates', () => {
  assert.equal(normalizeBubble({ box_2d: [0, 0, 'x', 10], english: 'Hello' }), null);
});

test('rejects an inverted or zero-area box', () => {
  assert.equal(normalizeBubble({ box_2d: [100, 20, 10, 200], english: 'Hello' }), null);
  assert.equal(normalizeBubble({ box_2d: [50, 50, 50, 50], english: 'Hello' }), null);
});

test('clamps coordinates into the 0-1000 space the prompt asks for', () => {
  const bubble = normalizeBubble({ box_2d: [-40, -10, 4000, 1200], english: 'Hello' });
  assert.deepEqual(bubble.box_2d, [0, 0, 1000, 1000]);
});

test('rejects a bubble whose text is empty or whitespace', () => {
  assert.equal(normalizeBubble({ box_2d: [0, 0, 10, 10], english: '   ' }), null);
});

test('reads the requested text key, so OCR-only results survive', () => {
  const bubble = normalizeBubble({ box_2d: [0, 0, 10, 10], source: 'こんにちは' }, 'source');
  assert.equal(bubble.source, 'こんにちは');
  // The same input has no translation yet, so the default key must reject it.
  assert.equal(normalizeBubble({ box_2d: [0, 0, 10, 10], source: 'こんにちは' }), null);
});

test('defaults a missing source to an empty string rather than "undefined"', () => {
  const bubble = normalizeBubble({ box_2d: [0, 0, 10, 10], english: 'Hello' });
  assert.equal(bubble.source, '');
});

test('truncates very long text', () => {
  const bubble = normalizeBubble({ box_2d: [0, 0, 10, 10], english: 'a'.repeat(5000) });
  assert.equal(bubble.english.length, 2000);
});

test('drops invalid entries and caps the list length', () => {
  const input = [
    { box_2d: [0, 0, 10, 10], english: 'keep' },
    { box_2d: [0, 0, 10, 10] },
    ...Array.from({ length: MAX_BUBBLES + 20 }, () => ({ box_2d: [0, 0, 10, 10], english: 'x' }))
  ];
  const bubbles = normalizeBubbles(input);
  assert.equal(bubbles.length, MAX_BUBBLES);
  assert.equal(bubbles[0].english, 'keep');
});

test('returns an empty list for a non-array', () => {
  assert.deepEqual(normalizeBubbles(null), []);
  assert.deepEqual(normalizeBubbles('nope'), []);
});

test('reports no overlap for disjoint rects', () => {
  const a = { left: 0, top: 0, width: 10, height: 10 };
  const b = { left: 100, top: 100, width: 10, height: 10 };
  assert.equal(overlapRatio(a, b), 0);
  assert.equal(rectsSubstantiallyOverlap(a, b), false);
});

test('reports full overlap when one rect contains the other', () => {
  const outer = { left: 0, top: 0, width: 100, height: 100 };
  const inner = { left: 10, top: 10, width: 20, height: 20 };
  // The ratio is against the smaller rect, so a contained rect counts as fully overlapping.
  assert.equal(overlapRatio(outer, inner), 1);
  assert.equal(rectsSubstantiallyOverlap(outer, inner), true);
});

test('treats a sliver of shared area as not overlapping', () => {
  const a = { left: 0, top: 0, width: 100, height: 100 };
  const b = { left: 95, top: 0, width: 100, height: 100 };
  assert.equal(rectsSubstantiallyOverlap(a, b), false);
});

test('respects a custom threshold', () => {
  const a = { left: 0, top: 0, width: 100, height: 100 };
  const b = { left: 80, top: 0, width: 100, height: 100 };
  assert.equal(rectsSubstantiallyOverlap(a, b, 0.5), false);
  assert.equal(rectsSubstantiallyOverlap(a, b, 0.1), true);
});

test('handles a missing rect without throwing', () => {
  assert.equal(overlapRatio(null, { left: 0, top: 0, width: 1, height: 1 }), 0);
  assert.equal(rectsSubstantiallyOverlap(undefined, undefined), false);
});
