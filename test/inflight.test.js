import test from 'node:test';
import assert from 'node:assert/strict';
import { addInflightSubscriber, createInflightEntry, listInflightSubscribers, removeInflightSubscriber } from '../src/shared/inflight.js';

test('tracks every subscriber attached to shared work', () => {
  const entry = createInflightEntry();
  addInflightSubscriber(entry, 'first', 10);
  addInflightSubscriber(entry, 'second', 20);

  assert.deepEqual(listInflightSubscribers(entry), [
    { requestId: 'first', tabId: 10 },
    { requestId: 'second', tabId: 20 }
  ]);
});

test('cancelling one subscriber keeps shared work alive', () => {
  const entry = createInflightEntry();
  addInflightSubscriber(entry, 'first', 10);
  addInflightSubscriber(entry, 'second', 20);

  assert.equal(removeInflightSubscriber(entry, 'first'), true);
  assert.equal(entry.controller.signal.aborted, false);
  assert.deepEqual(listInflightSubscribers(entry), [{ requestId: 'second', tabId: 20 }]);
});

test('shared work aborts after its final subscriber cancels', () => {
  const entry = createInflightEntry();
  addInflightSubscriber(entry, 'only', 10);

  assert.equal(removeInflightSubscriber(entry, 'only'), true);
  assert.equal(entry.controller.signal.aborted, true);
});