// Translation pipeline: sends the captured image to the worker and renders the
// resulting bubbles, including streamed partial bubbles as they arrive.

import { state } from './state.js';
import { showToast, updateStatus } from './status.js';
import { normalizeBubble, renderDisplayMode, renderBubbleOverlay, removeOverlaysInRegion, resolveBubbleOverlaps } from './bubbles.js';
import { savePageSession, rememberCaptureRect, refreshPageTurnBaseline } from './session.js';

// Renders a single streamed bubble the moment the model finishes it. These overlays are
// provisional: the final TRANSLATE_IMAGE response re-renders authoritatively and clears them.
export function renderPartialBubble(region) {
  const context = state.activeStreamContext;
  if (!context) return;
  const bubble = normalizeBubble(region);
  if (!bubble) return;
  bubble.id = `${context.recordId}:partial:${context.partialCount}`;
  bubble.recordId = context.recordId;
  context.partialCount += 1;
  const overlay = renderBubbleOverlay(bubble, context.selectionRect, context.config, context.partialCount);
  if (overlay) {
    overlay.classList.add('manga-partial-overlay');
    context.partialOverlays.push(overlay);
  }
}

export async function processImageWithAI(base64Image, selectionRect, loadingDiv) {
  if (state.activeRequestId) {
    loadingDiv.remove();
    showToast('A translation is already running. Wait for it to finish or cancel it first.', 'error');
    return;
  }
  // Note: the API key is deliberately never read here. It stays in the service worker.
  const config = await chrome.storage.local.get([
    'apiEndpoint', 'apiModel',
    'bubbleScaleMode', 'widthScale', 'heightScale', 'bubbleType',
    'fontSizeMode', 'manualFontSize', 'fontFamily',
    'bubbleBgColor', 'textColor', 'persistOverlays', 'displayMode', 'readingOrder'
  ]);

  if (!config.apiEndpoint) {
    showToast('Open the extension settings and save your API endpoint first.', 'error');
    loadingDiv.remove();
    return;
  }

  const requestId = crypto.randomUUID();
  const requestGeneration = state.pageGeneration;
  const requestUrl = location.href;
  const recordId = crypto.randomUUID();
  state.activeRequestId = requestId;
  state.activeStreamContext = { selectionRect, config, recordId, partialCount: 0, partialOverlays: [] };
  updateStatus('Finding text regions...');
  chrome.runtime.sendMessage({
    action: "TRANSLATE_IMAGE",
    base64Image,
    requestId
  }, async (response) => {
    if (requestId !== state.activeRequestId || requestGeneration !== state.pageGeneration || requestUrl !== location.href) return;
    try {
      loadingDiv.remove();
      state.activeStatus = null;

      if (chrome.runtime.lastError) {
        showToast(`Extension error: ${chrome.runtime.lastError.message}`, 'error');
        return;
      }

      if (!response || !response.success) {
        console.error("API Error Response:", response?.error);
        showToast(`Translation failed: ${response?.error || 'Unknown error'}`, 'error', 8000);
        return;
      }

      const bubbles = response.data.bubbles;

      if (Array.isArray(bubbles) && bubbles.length > 0) {
        removeOverlaysInRegion(selectionRect);
        const normalized = bubbles.map((bubble, index) => {
          const normalizedBubble = normalizeBubble(bubble);
          if (normalizedBubble) normalizedBubble.id = `${recordId}:${index}`;
          return normalizedBubble;
        }).filter(Boolean).slice(0, 100);
        normalized.forEach(bubble => { bubble.recordId = recordId; });
        const createdOverlays = renderDisplayMode(normalized, selectionRect, config);
        rememberCaptureRect(selectionRect);

        // 2. Resolve overlaps & clamp to page boundaries
        resolveBubbleOverlaps(createdOverlays);
        refreshPageTurnBaseline();
        if (config.persistOverlays !== false) {
          try {
            await savePageSession(normalized, selectionRect, config, recordId);
          } catch (error) {
            console.warn('Translation rendered, but its page session could not be saved:', error.message);
            showToast('Translation shown, but it could not be saved for reload.', 'error', 5000);
          }
        }
      } else {
        showToast('No manga text was detected. Try a tighter region, or a model with vision support.', 'error', 8000);
      }

      // Remove the provisional streamed overlays only after the final set is in the DOM,
      // so there is no blank flash between the streamed bubbles and the authoritative ones.
      state.activeStreamContext?.partialOverlays.forEach(overlay => overlay.remove());
      state.activeStreamContext = null;
    } catch (e) {
      console.error("Translation rendering error:", e);
    } finally {
      // Any early return (error, empty result) still leaves provisional overlays behind.
      state.activeStreamContext?.partialOverlays.forEach(overlay => overlay.remove());
      state.activeStreamContext = null;
      if (state.activeRequestId === requestId) state.activeRequestId = null;
    }
  });
}
