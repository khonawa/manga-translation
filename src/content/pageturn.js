// Page-turn detection and auto-translate scheduling: watches for URL/DOM changes and
// clears or re-translates overlays when the underlying page changes.

import { state } from './state.js';
import { getSessionKey } from './session.js';
import { processFullPageTranslation } from './capture.js';

export function clearAllOverlays({ cancelRequest = true, sessionKey = getSessionKey() } = {}) {
  state.pageGeneration += 1;
  if (cancelRequest && state.activeRequestId) {
    chrome.runtime.sendMessage({ action: 'CANCEL_TRANSLATION', requestId: state.activeRequestId }).catch(() => {});
    state.activeRequestId = null;
  }
  state.activeStatus?.remove();
  state.activeStatus = null;
  document.querySelectorAll('.manga-translation-overlay').forEach(el => el.remove());
  document.querySelectorAll('.manga-display-panel, .manga-overlay-menu, .manga-bubble-marker').forEach(el => el.remove());
  void chrome.storage.local.remove(sessionKey);
  state.translatedImageSignature = null;
  state.activeCaptureRects = [];
  syncPageTurnWatchers();
}

export function schedulePageTurnCheck() {
  clearTimeout(state.pageTurnCheckTimer);
  state.pageTurnCheckTimer = setTimeout(checkForPageTurn, 150);
}

export async function initializePageTurnClearing() {
  const stored = await chrome.storage.local.get(['clearOverlaysOnPageTurn', 'autoTranslateEnabled']);
  state.clearOverlaysOnPageTurn = stored.clearOverlaysOnPageTurn === true;
  state.autoTranslateEnabled = stored.autoTranslateEnabled === true;
  chrome.storage.onChanged.addListener(changes => {
    if (changes.clearOverlaysOnPageTurn) {
      state.clearOverlaysOnPageTurn = changes.clearOverlaysOnPageTurn.newValue === true;
      state.translatedImageSignature = state.clearOverlaysOnPageTurn ? getTranslatedImageSignature() : null;
      syncPageTurnWatchers();
    }
    if (changes.autoTranslateEnabled) {
      state.autoTranslateEnabled = changes.autoTranslateEnabled.newValue === true;
      if (!state.autoTranslateEnabled) clearTimeout(state.autoTranslateTimer);
      syncPageTurnWatchers();
    }
  });

  // Navigation events are effectively free, so they can stay wired for the page's lifetime.
  window.addEventListener('popstate', schedulePageTurnCheck);
  window.addEventListener('hashchange', schedulePageTurnCheck);
  if (window.navigation) window.navigation.addEventListener('navigate', schedulePageTurnCheck);
  syncPageTurnWatchers();
}

// The polling timer and document-wide observer only earn their cost while overlays are on
// screen and the user actually wants page-turn clearing, so attach and tear down on demand.
export function syncPageTurnWatchers() {
  const needed = (state.clearOverlaysOnPageTurn && hasVisibleOverlays()) || state.autoTranslateEnabled;
  if (needed === Boolean(state.pageTurnWatchers)) return;
  if (!needed) {
    clearInterval(state.pageTurnWatchers.intervalId);
    state.pageTurnWatchers.observer.disconnect();
    state.pageTurnWatchers = null;
    return;
  }

  const observer = new MutationObserver(schedulePageTurnCheck);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'srcset']
  });
  state.pageTurnWatchers = {
    intervalId: setInterval(() => {
      if (location.href !== state.observedPageUrl) schedulePageTurnCheck();
    }, 1000),
    observer
  };
}

export function hasVisibleOverlays() {
  return Boolean(document.querySelector('.manga-translation-overlay, .manga-display-panel'));
}

export function checkForPageTurn() {
  const wantsCheck = (state.clearOverlaysOnPageTurn && hasVisibleOverlays()) || state.autoTranslateEnabled;
  if (!wantsCheck) return;
  if (location.href !== state.observedPageUrl) {
    const previousSessionKey = state.renderedSessionKey;
    state.observedPageUrl = location.href;
    if (state.clearOverlaysOnPageTurn) clearAllOverlays({ sessionKey: previousSessionKey });
    state.renderedSessionKey = getSessionKey();
    scheduleAutoTranslate();
    return;
  }

  const currentSignature = getTranslatedImageSignature();
  if (state.translatedImageSignature === null) state.translatedImageSignature = currentSignature;
  else if (currentSignature !== state.translatedImageSignature) {
    if (state.clearOverlaysOnPageTurn) clearAllOverlays();
    scheduleAutoTranslate();
  }
}

export function scheduleAutoTranslate() {
  if (!state.autoTranslateEnabled || state.activeRequestId) return;
  clearTimeout(state.autoTranslateTimer);
  state.autoTranslateTimer = setTimeout(() => {
    if (!state.autoTranslateEnabled || state.activeRequestId) return;
    // Skip when the tab is hidden — captureVisibleTab would fail anyway, and on
    // mobile browsers (Kiwi) it throws "No active web contents to capture".
    if (document.visibilityState !== 'visible') return;
    // captureVisibleTab is quota-limited to 2 calls/second; enforce a cooldown.
    const now = Date.now();
    if (now - state.lastAutoCaptureAt < 2000) return;
    state.lastAutoCaptureAt = now;
    processFullPageTranslation({ silent: true });
  }, 800);
}

export function getTranslatedImageSignature() {
  const captures = state.activeCaptureRects.map(rect => ({
    left: rect.left,
    top: rect.top,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height
  }));
  if (!captures.length) return '';

  return [...document.images]
    .filter(image => {
      const rect = image.getBoundingClientRect();
      const imageBounds = {
        left: rect.left + window.scrollX,
        top: rect.top + window.scrollY,
        right: rect.right + window.scrollX,
        bottom: rect.bottom + window.scrollY
      };
      return captures.some(capture => imageBounds.left < capture.right && imageBounds.right > capture.left && imageBounds.top < capture.bottom && imageBounds.bottom > capture.top);
    })
    .map(image => {
      const rect = image.getBoundingClientRect();
      return `${image.currentSrc || image.src}|${image.naturalWidth}x${image.naturalHeight}|${Math.round(rect.left)},${Math.round(rect.top)},${Math.round(rect.width)},${Math.round(rect.height)}`;
    })
    .concat([...document.querySelectorAll('canvas')].filter(canvas => {
      const rect = canvas.getBoundingClientRect();
      const bounds = { left: rect.left + window.scrollX, top: rect.top + window.scrollY, right: rect.right + window.scrollX, bottom: rect.bottom + window.scrollY };
      return captures.some(capture => bounds.left < capture.right && bounds.right > capture.left && bounds.top < capture.bottom && bounds.bottom > capture.top);
    }).map(canvas => {
      const rect = canvas.getBoundingClientRect();
      return `canvas|${canvas.width}x${canvas.height}|${Math.round(rect.left)},${Math.round(rect.top)},${Math.round(rect.width)},${Math.round(rect.height)}`;
    }))
    .sort()
    .join('\n');
}
