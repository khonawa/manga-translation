// Content-script entry point. Wires up shared state, runs startup side effects, and
// registers the global event/message listeners. esbuild bundles this into the IIFE
// that Chrome injects as a classic content script.

import { state } from './state.js';
import { getSessionKey, restorePageSession } from './session.js';
import { initializePageTurnClearing, clearAllOverlays } from './pageturn.js';
import { initFloatPanel } from './floatpanel.js';
import { enableSnipMode, cancelSnipMode } from './snip.js';
import { processFullPageTranslation } from './capture.js';
import { saveVisibleScreenshot } from './screenshot.js';
import { updateStatus } from './status.js';
import { renderPartialBubble } from './translate.js';

// Previously `let renderedSessionKey = getSessionKey();` at the top of the IIFE.
state.renderedSessionKey = getSessionKey();

restorePageSession();
initializePageTurnClearing();
initFloatPanel();

document.addEventListener('mousedown', event => {
  const menu = document.querySelector('.manga-overlay-menu');
  if (menu && !menu.contains(event.target)) menu.remove();
}, true);

window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  // Only react when the extension actually has something to dismiss, otherwise
  // Escape inside a site's own input would cancel requests and clear storage.
  const snipActive = state.isSelecting || !!document.querySelector('.manga-capture-shield');
  const hasExtensionUi = !!document.querySelector(
    '.manga-translation-overlay, .manga-display-panel, .manga-bubble-marker, .manga-overlay-menu'
  );
  if (!snipActive && !hasExtensionUi && !state.activeRequestId) return;
  cancelSnipMode();
  clearAllOverlays();
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "START_SNIP") {
    enableSnipMode('translate');
  } else if (request.action === "START_FULL_PAGE") {
    processFullPageTranslation();
  } else if (request.action === "CLEAR_OVERLAYS") {
    clearAllOverlays();
  } else if (request.action === "SAVE_REGION_SCREENSHOT") {
    enableSnipMode('screenshot');
  } else if (request.action === "SAVE_PAGE_SCREENSHOT") {
    saveVisibleScreenshot();
  } else if (request.action === "TRANSLATION_PROGRESS" && request.requestId === state.activeRequestId) {
    updateStatus(request.message);
  } else if (request.action === "TRANSLATION_PARTIAL" && request.requestId === state.activeRequestId) {
    renderPartialBubble(request.region);
  }
});
