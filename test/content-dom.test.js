import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://example.com/reader' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.location = dom.window.location;
globalThis.getComputedStyle = dom.window.getComputedStyle;
globalThis.requestAnimationFrame = callback => callback();
globalThis.chrome = { storage: { local: {} }, runtime: {} };

const { clampOverlayToDocument, sortBubblesByReadingOrder } = await import('../src/content/bubbles.js');

test('clamps an overlay inside document margins', () => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 600 });
  const overlay = document.createElement('div');
  overlay.style.left = '-40px';
  overlay.style.top = '900px';
  overlay.getBoundingClientRect = () => ({ width: 120, height: 80 });

  clampOverlayToDocument(overlay);

  assert.equal(overlay.style.left, '8px');
  assert.equal(overlay.style.top, '512px');
});

test('sorts a manga row right-to-left by default', () => {
  const left = { id: 'left', box_2d: [100, 100, 250, 250] };
  const right = { id: 'right', box_2d: [100, 700, 250, 850] };

  assert.deepEqual(sortBubblesByReadingOrder([left, right]).map(item => item.id), ['right', 'left']);
  assert.deepEqual(sortBubblesByReadingOrder([left, right], 'ltr').map(item => item.id), ['left', 'right']);
});