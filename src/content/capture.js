// Screen capture: full-page translation entry, native region cropping, and the
// compositor/UI-hiding helpers that keep extension chrome out of screenshots.

import { state } from './state.js';
import { setStatusText, addCancelButton } from './status.js';
import { processImageWithAI } from './translate.js';

export async function processFullPageTranslation({ silent = false } = {}) {
  const fullPageRect = {
    left: 0,
    top: 0,
    width: window.innerWidth,
    height: window.innerHeight
  };

  const statusBanner = document.createElement('div');
  // Classed so hideExtensionUiForCapture() keeps it out of the screenshot.
  statusBanner.className = 'manga-capture-status';
  statusBanner.style.position = 'fixed';
  statusBanner.style.top = '20px';
  statusBanner.style.left = '50%';
  statusBanner.style.transform = 'translateX(-50%)';
  statusBanner.style.backgroundColor = '#2563eb';
  statusBanner.style.color = '#fff';
  statusBanner.style.padding = '10px 20px';
  statusBanner.style.borderRadius = '20px';
  statusBanner.style.fontWeight = 'bold';
  statusBanner.style.zIndex = '9999999';
  statusBanner.style.boxShadow = '0 4px 12px rgba(0,0,0,0.3)';
  setStatusText(statusBanner, 'Translating Visible Screen...');
  document.body.appendChild(statusBanner);
  state.activeStatus = statusBanner;
  addCancelButton(statusBanner);

  try {
    const base64Image = await cropNativeScreenshot(fullPageRect);
    await processImageWithAI(base64Image, fullPageRect, statusBanner);
  } catch (err) {
    const isCaptureFailure = /capture|web contents|MAX_CAPTURE/i.test(String(err?.message || err));
    // Auto-translate capture failures are expected on mobile/background tabs —
    // skip quietly instead of flashing a red banner every time the DOM shifts.
    if (silent && isCaptureFailure) {
      statusBanner.remove();
      if (state.activeStatus === statusBanner) state.activeStatus = null;
      return;
    }
    console.error("Full Page Manga Translator Error:", err);
    statusBanner.style.backgroundColor = "#dc2626";
    setStatusText(statusBanner, isCaptureFailure ? 'Screen Capture Failed' : 'API Translation Error');
    setTimeout(() => statusBanner.remove(), 4000);
  }
}

/**
 * Sends the region to the worker and gets back only the cropped JPEG. Cropping used to happen
 * here, which meant decoding a full-viewport JPEG and re-encoding it: two lossy passes over the
 * exact pixels the OCR model reads, plus a full screenshot crossing messaging in each direction.
 */
export async function cropNativeScreenshot(rect, { includeTranslationOverlays = false } = {}) {
  // captureVisibleTab photographs the real page, so anything this extension has drawn
  // lands in the image: the selection box (already restyled into a dark status panel by
  // this point), overlays from earlier snips, toasts, menus. Hide them for the capture.
  const restoreChrome = hideExtensionUiForCapture({ includeTranslationOverlays });
  try {
    await waitForCompositorPaint();
    const response = await chrome.runtime.sendMessage({
      action: 'CAPTURE_REGION',
      rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      viewport: { width: window.innerWidth, height: window.innerHeight }
    });
    if (!response?.dataUrl) throw new Error(response?.error || 'Failed to capture tab');
    return response.dataUrl;
  } finally {
    restoreChrome();
  }
}

export function waitForCompositorPaint() {
  return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

/**
 * Hides every element this extension has added to the page and returns a function that
 * puts them back. visibility is used rather than display so nothing reflows: the page
 * underneath must be pixel-identical to what the user selected against.
 */
export function hideExtensionUiForCapture({ includeTranslationOverlays = false } = {}) {
  const selectors = [
    '.manga-overlay-menu',
    '.manga-toast',
    '.manga-capture-shield',
    '.manga-capture-status',
    '#manga-float-panel'
  ];
  if (!includeTranslationOverlays) {
    selectors.push(
      '.manga-translation-overlay',
      '.manga-display-panel',
      '.manga-bubble-marker'
    );
  }

  const hidden = [];
  document.querySelectorAll(selectors.join(', ')).forEach(element => {
    hidden.push([element, element.style.getPropertyValue('visibility'), element.style.getPropertyPriority('visibility')]);
    element.style.setProperty('visibility', 'hidden', 'important');
  });
  // The selection rectangle is a plain inline-styled div, tracked separately.
  if (state.overlayDiv) {
    hidden.push([state.overlayDiv, state.overlayDiv.style.getPropertyValue('visibility'), state.overlayDiv.style.getPropertyPriority('visibility')]);
    state.overlayDiv.style.setProperty('visibility', 'hidden', 'important');
  }

  return () => {
    hidden.forEach(([element, value, priority]) => {
      if (value) element.style.setProperty('visibility', value, priority);
      else element.style.removeProperty('visibility');
    });
  };
}
