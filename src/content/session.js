// Page-session persistence: hash-based session keys, saving/restoring the
// translated bubbles for a URL, and tracking the regions captured on this page.

import { state } from './state.js';
import { normalizeBubble, renderDisplayMode, resolveBubbleOverlaps } from './bubbles.js';
import { getTranslatedImageSignature, syncPageTurnWatchers } from './pageturn.js';
import { rectsSubstantiallyOverlap as sharedRectsSubstantiallyOverlap } from '../shared/bubbles.js';
import { hashString } from '../shared/hash.js';

export { hashString };

export function getSessionKey() {
  return `pageSession:${hashString(location.href)}`;
}

export async function savePageSession(bubbles, selectionRect, config, recordId = crypto.randomUUID()) {
  const rect = {
    left: selectionRect.left + window.scrollX,
    top: selectionRect.top + window.scrollY,
    width: selectionRect.width,
    height: selectionRect.height
  };
  const renderingConfig = {
    bubbleScaleMode: config.bubbleScaleMode,
    widthScale: config.widthScale,
    heightScale: config.heightScale,
    bubbleType: config.bubbleType,
    fontSizeMode: config.fontSizeMode,
    manualFontSize: config.manualFontSize,
    fontFamily: config.fontFamily,
    bubbleBgColor: config.bubbleBgColor,
    textColor: config.textColor,
    displayMode: config.displayMode,
    readingOrder: config.readingOrder
  };
  const key = getSessionKey();
  const existing = (await chrome.storage.local.get(key))[key];
  const records = Array.isArray(existing?.records)
    ? existing.records
    : existing?.bubbles && existing?.rect
      ? [{ bubbles: existing.bubbles, rect: existing.rect, config: existing.config }]
      : [];
  const retainedRecords = records.filter(record => !rectsSubstantiallyOverlap(record.rect, rect));
  retainedRecords.push({ id: recordId, bubbles, rect, config: renderingConfig });
  await chrome.storage.local.set({
    [key]: { records: retainedRecords.slice(-20), createdAt: Date.now() }
  });
  state.renderedSessionKey = key;
}

export async function restorePageSession() {
  const { persistOverlays } = await chrome.storage.local.get('persistOverlays');
  if (persistOverlays === false) return;
  const key = getSessionKey();
  const session = (await chrome.storage.local.get(key))[key];
  if (!session) return;
  const records = Array.isArray(session.records)
    ? session.records
    : session.bubbles && session.rect
      ? [{ bubbles: session.bubbles, rect: session.rect, config: session.config }]
      : [];
  const overlays = [];
  records.forEach(record => {
    if (!record?.bubbles || !record.rect) return;
    const viewportRect = {
      ...record.rect,
      left: record.rect.left - window.scrollX,
      top: record.rect.top - window.scrollY
    };
    const recordId = record.id || crypto.randomUUID();
    const bubbles = record.bubbles.map((bubble, index) => {
      const normalized = normalizeBubble(bubble);
      if (!normalized) return null;
      normalized.id = bubble.id || `${recordId}:${index}`;
      normalized.recordId = recordId;
      normalized.offsetX = Number(bubble.offsetX) || 0;
      normalized.offsetY = Number(bubble.offsetY) || 0;
      return normalized;
    }).filter(Boolean);
    overlays.push(...renderDisplayMode(bubbles, viewportRect, record.config || {}));
    state.activeCaptureRects.push(record.rect);
  });
  resolveBubbleOverlaps(overlays);
  state.renderedSessionKey = key;
  refreshPageTurnBaseline();
}

export function rememberCaptureRect(selectionRect) {
  const rect = {
    left: selectionRect.left + window.scrollX,
    top: selectionRect.top + window.scrollY,
    width: selectionRect.width,
    height: selectionRect.height
  };
  state.activeCaptureRects = state.activeCaptureRects.filter(existing => !rectsSubstantiallyOverlap(existing, rect));
  state.activeCaptureRects.push(rect);
}

// Canonical implementation lives in src/shared/bubbles.js (bundled here via esbuild).
export function rectsSubstantiallyOverlap(first, second) {
  return sharedRectsSubstantiallyOverlap(first, second, 0.35);
}

export function refreshPageTurnBaseline() {
  state.observedPageUrl = location.href;
  state.translatedImageSignature = state.clearOverlaysOnPageTurn ? getTranslatedImageSignature() : null;
  syncPageTurnWatchers();
}
