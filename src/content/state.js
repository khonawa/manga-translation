// Shared mutable state for the content script. Previously these were top-level `let`
// bindings inside one giant IIFE; splitting the script into modules means they need a
// single shared home that every module imports. The object is mutated in place, so
// importers always see the current value (unlike re-exported `let` bindings).

export const state = {
  isSelecting: false,
  startX: 0,
  startY: 0,
  overlayDiv: null,
  activeRequestId: null,
  activeStatus: null,
  selectionPurpose: 'translate',
  clearOverlaysOnPageTurn: false,
  autoTranslateEnabled: false,
  autoTranslateTimer: null,
  lastAutoCaptureAt: 0,
  observedPageUrl: location.href,
  translatedImageSignature: null,
  pageTurnCheckTimer: null,
  pageTurnWatchers: null,
  pageGeneration: 0,
  renderedSessionKey: null, // initialised in index.js (needs getSessionKey)
  activeCaptureRects: [],
  activeStreamContext: null
};
