import test from 'node:test';
import assert from 'node:assert/strict';

import { parseJsonArray, normalizeTranslationArray, createStreamingRegionParser } from '../src/shared/parse.js';

test('passes through an array that is already parsed', () => {
  const input = [{ index: 0 }];
  assert.deepEqual(parseJsonArray(input), input);
});

test('parses a bare JSON array', () => {
  assert.deepEqual(parseJsonArray('[{"index":0}]'), [{ index: 0 }]);
});

test('strips markdown fences', () => {
  assert.deepEqual(parseJsonArray('```json\n[{"index":1}]\n```'), [{ index: 1 }]);
});

test('finds an array embedded in prose', () => {
  const content = 'Here you go:\n[{"index":2}]\nHope that helps.';
  assert.deepEqual(parseJsonArray(content), [{ index: 2 }]);
});

test('unwraps a regions object, which is what structured output returns', () => {
  const content = JSON.stringify({ regions: [{ box_2d: [0, 0, 10, 10], english: 'hi' }] });
  assert.deepEqual(parseJsonArray(content), [{ box_2d: [0, 0, 10, 10], english: 'hi' }]);
});

test('unwraps a translations object', () => {
  const content = JSON.stringify({ translations: [{ index: 0, translation: 'hi' }] });
  assert.deepEqual(parseJsonArray(content), [{ index: 0, translation: 'hi' }]);
});

test('recovers the intact objects from a truncated array', () => {
  // Models that hit the token limit cut off mid-array; the complete leading objects
  // are still worth keeping rather than failing the whole translation.
  const content = '[{"index":0,"translation":"one"},{"index":1,"translation":"two"},{"index":2,"transl';
  assert.deepEqual(parseJsonArray(content), [
    { index: 0, translation: 'one' },
    { index: 1, translation: 'two' }
  ]);
});

test('does not treat a bracket inside a string as the array end', () => {
  const parsed = parseJsonArray('[{"translation":"see [1] below"}]');
  assert.deepEqual(parsed, [{ translation: 'see [1] below' }]);
});

test('throws when there is no array at all', () => {
  assert.throws(() => parseJsonArray('I cannot help with that.'), /invalid structured output/i);
});

test('throws on empty input', () => {
  assert.throws(() => parseJsonArray(''), /invalid structured output/i);
});

test('maps translations by index', () => {
  const map = normalizeTranslationArray('[{"index":0,"translation":"one"},{"index":2,"translation":"three"}]');
  assert.equal(map.get(0), 'one');
  assert.equal(map.get(2), 'three');
  assert.equal(map.get(1), undefined);
});

test('coerces string indexes and trims translations', () => {
  const map = normalizeTranslationArray('[{"index":"3","translation":"  spaced  "}]');
  assert.equal(map.get(3), 'spaced');
});

test('streaming parser emits each region only once it closes', () => {
  const parser = createStreamingRegionParser();
  const first = parser.push('{"regions":[{"box_2d":[0,0,10,10],"source":"a","english":"A"}');
  assert.deepEqual(first, [{ box_2d: [0, 0, 10, 10], source: 'a', english: 'A' }]);
  // A partial second object is not emitted until its closing brace arrives.
  assert.deepEqual(parser.push(',{"box_2d":[1,1,9,9],"source":"b","engl'), []);
  const rest = parser.push('ish":"B"}]}');
  assert.deepEqual(rest, [{ box_2d: [1, 1, 9, 9], source: 'b', english: 'B' }]);
  assert.deepEqual(parser.finish(), [
    { box_2d: [0, 0, 10, 10], source: 'a', english: 'A' },
    { box_2d: [1, 1, 9, 9], source: 'b', english: 'B' }
  ]);
});

test('streaming parser ignores non-region objects such as the wrapper', () => {
  const parser = createStreamingRegionParser();
  const emitted = parser.push('{"regions":[{"box_2d":[0,0,5,5],"source":"x","english":"X"}]}');
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].english, 'X');
});
