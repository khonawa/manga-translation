(() => {
  // src/content/state.js
  var state = {
    isSelecting: false,
    startX: 0,
    startY: 0,
    overlayDiv: null,
    activeRequestId: null,
    activeStatus: null,
    selectionPurpose: "translate",
    clearOverlaysOnPageTurn: false,
    autoTranslateEnabled: false,
    autoTranslateTimer: null,
    lastAutoCaptureAt: 0,
    observedPageUrl: location.href,
    translatedImageSignature: null,
    pageTurnCheckTimer: null,
    pageTurnWatchers: null,
    pageGeneration: 0,
    renderedSessionKey: null,
    // initialised in index.js (needs getSessionKey)
    activeCaptureRects: [],
    activeStreamContext: null
  };

  // src/content/translate.js
  function renderPartialBubble(region) {
    const context = state.activeStreamContext;
    if (!context) return;
    const bubble = normalizeBubble(region);
    if (!bubble) return;
    bubble.id = `${context.recordId}:partial:${context.partialCount}`;
    bubble.recordId = context.recordId;
    context.partialCount += 1;
    const overlay = renderBubbleOverlay(bubble, context.selectionRect, context.config, context.partialCount);
    if (overlay) {
      overlay.classList.add("manga-partial-overlay");
      context.partialOverlays.push(overlay);
    }
  }
  async function processImageWithAI(base64Image, selectionRect, loadingDiv) {
    if (state.activeRequestId) {
      loadingDiv.remove();
      showToast("A translation is already running. Wait for it to finish or cancel it first.", "error");
      return;
    }
    const config = await chrome.storage.local.get([
      "apiEndpoint",
      "apiModel",
      "bubbleScaleMode",
      "widthScale",
      "heightScale",
      "bubbleType",
      "fontSizeMode",
      "manualFontSize",
      "fontFamily",
      "bubbleBgColor",
      "textColor",
      "persistOverlays",
      "displayMode",
      "readingOrder"
    ]);
    if (!config.apiEndpoint) {
      showToast("Open the extension settings and save your API endpoint first.", "error");
      loadingDiv.remove();
      return;
    }
    const requestId = crypto.randomUUID();
    const requestGeneration = state.pageGeneration;
    const requestUrl = location.href;
    const recordId = crypto.randomUUID();
    state.activeRequestId = requestId;
    state.activeStreamContext = { selectionRect, config, recordId, partialCount: 0, partialOverlays: [] };
    updateStatus("Finding text regions...");
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
          showToast(`Extension error: ${chrome.runtime.lastError.message}`, "error");
          return;
        }
        if (!response || !response.success) {
          console.error("API Error Response:", response?.error);
          showToast(`Translation failed: ${response?.error || "Unknown error"}`, "error", 8e3);
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
          normalized.forEach((bubble) => {
            bubble.recordId = recordId;
          });
          const createdOverlays = renderDisplayMode(normalized, selectionRect, config);
          rememberCaptureRect(selectionRect);
          resolveBubbleOverlaps(createdOverlays);
          refreshPageTurnBaseline();
          if (config.persistOverlays !== false) {
            try {
              await savePageSession(normalized, selectionRect, config, recordId);
            } catch (error) {
              console.warn("Translation rendered, but its page session could not be saved:", error.message);
              showToast("Translation shown, but it could not be saved for reload.", "error", 5e3);
            }
          }
        } else {
          showToast("No manga text was detected. Try a tighter region, or a model with vision support.", "error", 8e3);
        }
        state.activeStreamContext?.partialOverlays.forEach((overlay) => overlay.remove());
        state.activeStreamContext = null;
      } catch (e) {
        console.error("Translation rendering error:", e);
      } finally {
        state.activeStreamContext?.partialOverlays.forEach((overlay) => overlay.remove());
        state.activeStreamContext = null;
        if (state.activeRequestId === requestId) state.activeRequestId = null;
      }
    });
  }

  // src/content/capture.js
  async function processFullPageTranslation({ silent = false } = {}) {
    const fullPageRect = {
      left: 0,
      top: 0,
      width: window.innerWidth,
      height: window.innerHeight
    };
    const statusBanner = document.createElement("div");
    statusBanner.className = "manga-capture-status";
    statusBanner.style.position = "fixed";
    statusBanner.style.top = "20px";
    statusBanner.style.left = "50%";
    statusBanner.style.transform = "translateX(-50%)";
    statusBanner.style.backgroundColor = "#2563eb";
    statusBanner.style.color = "#fff";
    statusBanner.style.padding = "10px 20px";
    statusBanner.style.borderRadius = "20px";
    statusBanner.style.fontWeight = "bold";
    statusBanner.style.zIndex = "9999999";
    statusBanner.style.boxShadow = "0 4px 12px rgba(0,0,0,0.3)";
    setStatusText(statusBanner, "Translating Visible Screen...");
    document.body.appendChild(statusBanner);
    state.activeStatus = statusBanner;
    addCancelButton(statusBanner);
    try {
      const base64Image = await cropNativeScreenshot(fullPageRect);
      await processImageWithAI(base64Image, fullPageRect, statusBanner);
    } catch (err) {
      const isCaptureFailure = /capture|web contents|MAX_CAPTURE/i.test(String(err?.message || err));
      if (silent && isCaptureFailure) {
        statusBanner.remove();
        if (state.activeStatus === statusBanner) state.activeStatus = null;
        return;
      }
      console.error("Full Page Manga Translator Error:", err);
      statusBanner.style.backgroundColor = "#dc2626";
      setStatusText(statusBanner, isCaptureFailure ? "Screen Capture Failed" : "API Translation Error");
      setTimeout(() => statusBanner.remove(), 4e3);
    }
  }
  async function cropNativeScreenshot(rect, { includeTranslationOverlays = false } = {}) {
    const restoreChrome = hideExtensionUiForCapture({ includeTranslationOverlays });
    try {
      await waitForCompositorPaint();
      const response = await chrome.runtime.sendMessage({
        action: "CAPTURE_REGION",
        rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
        viewport: { width: window.innerWidth, height: window.innerHeight }
      });
      if (!response?.dataUrl) throw new Error(response?.error || "Failed to capture tab");
      return response.dataUrl;
    } finally {
      restoreChrome();
    }
  }
  function waitForCompositorPaint() {
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }
  function hideExtensionUiForCapture({ includeTranslationOverlays = false } = {}) {
    const selectors = [
      ".manga-overlay-menu",
      ".manga-toast",
      ".manga-capture-shield",
      ".manga-capture-status",
      "#manga-float-panel"
    ];
    if (!includeTranslationOverlays) {
      selectors.push(
        ".manga-translation-overlay",
        ".manga-display-panel",
        ".manga-bubble-marker"
      );
    }
    const hidden = [];
    document.querySelectorAll(selectors.join(", ")).forEach((element) => {
      hidden.push([element, element.style.getPropertyValue("visibility"), element.style.getPropertyPriority("visibility")]);
      element.style.setProperty("visibility", "hidden", "important");
    });
    if (state.overlayDiv) {
      hidden.push([state.overlayDiv, state.overlayDiv.style.getPropertyValue("visibility"), state.overlayDiv.style.getPropertyPriority("visibility")]);
      state.overlayDiv.style.setProperty("visibility", "hidden", "important");
    }
    return () => {
      hidden.forEach(([element, value, priority]) => {
        if (value) element.style.setProperty("visibility", value, priority);
        else element.style.removeProperty("visibility");
      });
    };
  }

  // src/content/screenshot.js
  async function saveVisibleScreenshot() {
    const response = await chrome.runtime.sendMessage({ action: "CAPTURE_TAB" });
    if (!response?.dataUrl) return showToast(response?.error || "Failed to capture the visible page.", "error");
    try {
      await downloadImage(response.dataUrl, "manga-visible-page");
      showToast("Screenshot saved.", "info", 2500);
    } catch (error) {
      showToast(error.message, "error");
    }
  }
  async function downloadImage(dataUrl, prefix) {
    const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
    const response = await chrome.runtime.sendMessage({ action: "DOWNLOAD_IMAGE", dataUrl, filename: `${prefix}-${stamp}.jpg` });
    if (!response?.success) throw new Error(response?.error || "Screenshot download failed.");
  }

  // src/content/snip.js
  function cancelSnipMode() {
    state.isSelecting = false;
    window.removeEventListener("click", preventClickPropagation, true);
    window.removeEventListener("mousedown", onMouseDown, true);
    window.removeEventListener("mousemove", onMouseMove, true);
    window.removeEventListener("mouseup", onMouseUp, true);
    document.body.style.cursor = "";
    document.documentElement.style.cursor = "";
    document.documentElement.classList.remove("manga-capture-active");
    document.querySelector(".manga-capture-shield")?.remove();
    if (state.overlayDiv && !state.overlayDiv.classList.contains("manga-translation-overlay")) {
      state.overlayDiv.remove();
    }
    state.overlayDiv = null;
  }
  function preventClickPropagation(e) {
    e.preventDefault();
    e.stopPropagation();
    return false;
  }
  function enableSnipMode(purpose = "translate") {
    cancelSnipMode();
    state.selectionPurpose = purpose;
    document.body.style.cursor = "crosshair";
    document.documentElement.style.cursor = "crosshair";
    document.documentElement.classList.add("manga-capture-active");
    installCaptureShield();
    window.addEventListener("click", preventClickPropagation, { capture: true, once: true });
    window.addEventListener("mousedown", onMouseDown, { capture: true, once: true });
  }
  function installCaptureShield() {
    document.querySelector(".manga-capture-shield")?.remove();
    const shield = document.createElement("div");
    shield.className = "manga-capture-shield";
    shield.addEventListener("click", preventClickPropagation, true);
    shield.addEventListener("dragstart", preventClickPropagation, true);
    shield.addEventListener("contextmenu", preventClickPropagation, true);
    document.documentElement.appendChild(shield);
    return shield;
  }
  function onMouseDown(e) {
    e.preventDefault();
    e.stopPropagation();
    state.isSelecting = true;
    state.startX = e.clientX;
    state.startY = e.clientY;
    state.overlayDiv = document.createElement("div");
    state.overlayDiv.style.position = "fixed";
    state.overlayDiv.style.border = "2px dashed #0066ff";
    state.overlayDiv.style.backgroundColor = "rgba(0, 102, 255, 0.15)";
    state.overlayDiv.style.zIndex = "9999999";
    state.overlayDiv.style.pointerEvents = "none";
    state.overlayDiv.style.left = `${state.startX}px`;
    state.overlayDiv.style.top = `${state.startY}px`;
    document.body.appendChild(state.overlayDiv);
    window.addEventListener("mousemove", onMouseMove, { capture: true });
    window.addEventListener("mouseup", onMouseUp, { capture: true, once: true });
  }
  function onMouseMove(e) {
    if (!state.isSelecting || !state.overlayDiv) return;
    e.preventDefault();
    e.stopPropagation();
    const currentX = e.clientX;
    const currentY = e.clientY;
    const width = Math.abs(currentX - state.startX);
    const height = Math.abs(currentY - state.startY);
    const left = Math.min(currentX, state.startX);
    const top = Math.min(currentY, state.startY);
    state.overlayDiv.style.width = `${width}px`;
    state.overlayDiv.style.height = `${height}px`;
    state.overlayDiv.style.left = `${left}px`;
    state.overlayDiv.style.top = `${top}px`;
  }
  async function onMouseUp(e) {
    e.preventDefault();
    e.stopPropagation();
    if (!state.isSelecting) return;
    state.isSelecting = false;
    window.removeEventListener("mousemove", onMouseMove, true);
    document.body.style.cursor = "";
    document.documentElement.style.cursor = "";
    document.documentElement.classList.remove("manga-capture-active");
    document.querySelector(".manga-capture-shield")?.remove();
    if (!state.overlayDiv) return;
    const rect = state.overlayDiv.getBoundingClientRect();
    if (rect.width < 20 || rect.height < 20) {
      state.overlayDiv.remove();
      state.overlayDiv = null;
      return;
    }
    state.overlayDiv.style.pointerEvents = "auto";
    state.overlayDiv.style.border = "2px solid #ffaa00";
    state.overlayDiv.style.backgroundColor = "rgba(0, 0, 0, 0.85)";
    setStatusText(state.overlayDiv, "Preparing image...");
    state.overlayDiv.style.color = "#fff";
    state.overlayDiv.style.fontWeight = "bold";
    state.overlayDiv.style.display = "flex";
    state.overlayDiv.style.alignItems = "center";
    state.overlayDiv.style.justifyContent = "center";
    try {
      state.activeStatus = state.overlayDiv;
      const base64Image = await cropNativeScreenshot(rect, {
        includeTranslationOverlays: state.selectionPurpose === "screenshot"
      });
      if (state.selectionPurpose === "screenshot") {
        await downloadImage(base64Image, "manga-region");
        state.overlayDiv.remove();
        state.overlayDiv = null;
        return;
      }
      addCancelButton(state.overlayDiv);
      await processImageWithAI(base64Image, rect, state.overlayDiv);
    } catch (err) {
      console.error("Manga Translator Error:", err);
      state.overlayDiv.style.backgroundColor = "rgba(255, 0, 0, 0.5)";
      setStatusText(state.overlayDiv, "API Error");
      setTimeout(() => state.overlayDiv?.remove(), 4e3);
    }
  }

  // src/content/status.js
  function addCancelButton(container) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Cancel";
    button.style.marginLeft = "10px";
    button.style.cursor = "pointer";
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (state.activeRequestId) {
        chrome.runtime.sendMessage({ action: "CANCEL_TRANSLATION", requestId: state.activeRequestId }).catch(() => {
        });
        state.activeRequestId = null;
        state.pageGeneration += 1;
      }
      state.activeStatus = null;
      cancelSnipMode();
      container.remove();
    });
    container.appendChild(button);
  }
  function showToast(message, variant = "info", duration = 5e3) {
    document.querySelector(".manga-toast")?.remove();
    const toast = document.createElement("div");
    toast.className = `manga-toast manga-toast-${variant}`;
    toast.setAttribute("role", variant === "error" ? "alert" : "status");
    toast.setAttribute("aria-live", variant === "error" ? "assertive" : "polite");
    const text = document.createElement("span");
    text.className = "manga-toast-text";
    text.textContent = message;
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "manga-toast-close";
    dismiss.setAttribute("aria-label", "Dismiss message");
    dismiss.textContent = "\xD7";
    dismiss.addEventListener("click", () => toast.remove());
    toast.append(text, dismiss);
    document.body.appendChild(toast);
    if (duration) setTimeout(() => toast.remove(), duration);
    return toast;
  }
  function setStatusText(container, message) {
    let label = container.querySelector(".manga-status-label");
    if (!label) {
      label = document.createElement("span");
      label.className = "manga-status-label";
      container.insertBefore(label, container.firstChild);
    }
    label.textContent = `${message} `;
    return label;
  }
  function updateStatus(message) {
    if (!state.activeStatus) return;
    setStatusText(state.activeStatus, message);
  }

  // src/shared/bubbles.js
  var MAX_TEXT_LENGTH = 2e3;
  function clampCoordinate(value) {
    return Math.max(0, Math.min(1e3, value));
  }
  function cleanText(value) {
    return String(value ?? "").trim().slice(0, MAX_TEXT_LENGTH);
  }
  function normalizeBubble2(bubble, textKey = "english") {
    if (!bubble || !Array.isArray(bubble.box_2d) || bubble.box_2d.length !== 4) return null;
    const box = bubble.box_2d.map(Number);
    if (!box.every(Number.isFinite)) return null;
    const [ymin, xmin, ymax, xmax] = box.map(clampCoordinate);
    if (ymax <= ymin || xmax <= xmin) return null;
    const text = cleanText(bubble[textKey]);
    if (!text) return null;
    const normalized = {
      box_2d: [ymin, xmin, ymax, xmax],
      source: cleanText(bubble.source)
    };
    normalized[textKey] = text;
    return normalized;
  }
  function overlapRatio(first, second) {
    if (!first || !second) return 0;
    const width = Math.max(0, Math.min(first.left + first.width, second.left + second.width) - Math.max(first.left, second.left));
    const height = Math.max(0, Math.min(first.top + first.height, second.top + second.height) - Math.max(first.top, second.top));
    const smaller = Math.max(1, Math.min(first.width * first.height, second.width * second.height));
    return width * height / smaller;
  }
  function rectsSubstantiallyOverlap(first, second, threshold = 0.35) {
    return overlapRatio(first, second) >= threshold;
  }

  // src/content/bubbles.js
  function normalizeBubble(bubble, textKey = "english") {
    return normalizeBubble2(bubble, textKey);
  }
  function renderDisplayMode(bubbles, selectionRect, config) {
    const orderedBubbles = sortBubblesByReadingOrder(bubbles, config.readingOrder);
    let mode = config.displayMode;
    if (mode === "subtitle-list") mode = "side-panel-numbered";
    if (mode === "side-panel") mode = "side-panel-numbered";
    if (["side-panel-numbered", "side-by-side"].includes(mode)) {
      renderTranslationPanel(orderedBubbles, mode, selectionRect);
      return [];
    }
    return orderedBubbles.map((bubble, index) => renderBubbleOverlay(bubble, selectionRect, config, index));
  }
  function sortBubblesByReadingOrder(bubbles, readingOrder = "rtl") {
    const direction = readingOrder === "ltr" ? 1 : -1;
    const items = bubbles.map((bubble, originalIndex) => {
      const [top, left, bottom, right] = bubble.box_2d;
      return { bubble, originalIndex, top, bottom, centerX: (left + right) / 2, centerY: (top + bottom) / 2, height: bottom - top };
    }).sort((a, b) => a.centerY - b.centerY || direction * (a.centerX - b.centerX));
    const rows = [];
    items.forEach((item) => {
      const row = rows.find((candidate) => {
        const verticalOverlap = Math.max(0, Math.min(candidate.bottom, item.bottom) - Math.max(candidate.top, item.top));
        return verticalOverlap >= Math.min(candidate.averageHeight, item.height) * 0.35 || Math.abs(candidate.centerY - item.centerY) <= Math.min(candidate.averageHeight, item.height) * 0.45;
      });
      if (row) {
        row.items.push(item);
        row.top = Math.min(row.top, item.top);
        row.bottom = Math.max(row.bottom, item.bottom);
        row.centerY = row.items.reduce((sum, entry) => sum + entry.centerY, 0) / row.items.length;
        row.averageHeight = row.items.reduce((sum, entry) => sum + entry.height, 0) / row.items.length;
      } else rows.push({ items: [item], top: item.top, bottom: item.bottom, centerY: item.centerY, averageHeight: item.height });
    });
    rows.sort((a, b) => a.centerY - b.centerY);
    return rows.flatMap((row) => row.items.sort((a, b) => direction * (a.centerX - b.centerX) || a.originalIndex - b.originalIndex).map((item) => item.bubble));
  }
  function renderBubbleOverlay(bubble, selectionRect, config, index = 0) {
    const [ymin, xmin, ymax, xmax] = bubble.box_2d;
    const originalWidth = Math.max(34, (xmax - xmin) / 1e3 * selectionRect.width);
    const originalHeight = Math.max(28, (ymax - ymin) / 1e3 * selectionRect.height);
    const centerLeft = selectionRect.left + (xmin + xmax) / 2e3 * selectionRect.width + window.scrollX;
    const centerTop = selectionRect.top + (ymin + ymax) / 2e3 * selectionRect.height + window.scrollY;
    const manualWidthScale = config.bubbleScaleMode === "manual" ? (config.widthScale || 100) / 100 : 1;
    const manualHeightScale = config.bubbleScaleMode === "manual" ? (config.heightScale || 100) / 100 : 1;
    let width = originalWidth;
    let height = originalHeight;
    const overlay = document.createElement("div");
    const bubbleShape = ["rectangle", "oval"].includes(config.bubbleType) ? config.bubbleType : "adaptive";
    const classNames = ["manga-translation-overlay", `manga-shape-${bubbleShape}`];
    overlay.className = classNames.join(" ");
    if (config.displayMode === "replace") overlay.classList.add("manga-replace-overlay");
    overlay.dataset.bubbleIndex = index;
    overlay.dataset.bubbleId = bubble.id || "";
    overlay.dataset.recordId = bubble.recordId || "";
    overlay.dataset.captureLeft = selectionRect.left + window.scrollX;
    overlay.dataset.captureTop = selectionRect.top + window.scrollY;
    overlay.dataset.captureWidth = selectionRect.width;
    overlay.dataset.captureHeight = selectionRect.height;
    overlay.style.setProperty("--manga-bg-color", config.bubbleBgColor || "#ffffff");
    overlay.style.setProperty("--manga-text-color", config.textColor || "#000000");
    overlay.style.setProperty("--manga-font-family", getFontFamily(config.fontFamily));
    overlay.style.top = `${centerTop - height / 2}px`;
    overlay.style.left = `${centerLeft - width / 2}px`;
    overlay.style.width = `${width}px`;
    overlay.style.height = `${height}px`;
    const textSpan = document.createElement("span");
    textSpan.className = "manga-text-content";
    textSpan.innerText = bubble.english;
    overlay.appendChild(textSpan);
    overlay.title = "Right-click or press Enter for actions | Drag to move";
    overlay.tabIndex = 0;
    overlay.setAttribute("role", "group");
    overlay.setAttribute("aria-label", `Translated text: ${bubble.english}`);
    overlay.addEventListener("contextmenu", (event) => showOverlayMenu(event, overlay, bubble));
    overlay.addEventListener("keydown", (event) => {
      if (event.target !== overlay) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        const rect = overlay.getBoundingClientRect();
        showOverlayMenu({ preventDefault() {
        }, clientX: rect.left, clientY: rect.bottom }, overlay, bubble);
      } else if (event.key === "F2") {
        event.preventDefault();
        startInlineEdit(overlay, bubble);
      }
    });
    enableOverlayDrag(overlay, bubble);
    document.body.appendChild(overlay);
    if (config.fontSizeMode === "manual" && config.manualFontSize) {
      overlay.style.fontSize = `${config.manualFontSize}px`;
    } else {
      overlay.style.fontSize = `${Math.min(18, Math.max(11, Math.sqrt(originalWidth * originalHeight / Math.max(8, bubble.english.length))))}px`;
    }
    ({ width, height } = fitBubbleToText(overlay, originalWidth, originalHeight, bubbleShape));
    if (config.bubbleScaleMode === "manual") {
      width = Math.max(40, width * manualWidthScale);
      height = Math.max(24, height * manualHeightScale);
      overlay.style.width = `${width}px`;
      overlay.style.height = `${height}px`;
      shrinkTextToFitBubble(overlay);
    }
    if (bubbleShape === "adaptive") setAdaptiveBubbleContour(overlay, width, height, index);
    overlay.style.left = `${centerLeft - width / 2 + (Number(bubble.offsetX) || 0)}px`;
    overlay.style.top = `${centerTop - height / 2 + (Number(bubble.offsetY) || 0)}px`;
    clampOverlayToDocument(overlay);
    return overlay;
  }
  function getBubbleChrome(overlay) {
    const style = getComputedStyle(overlay);
    return {
      horizontal: parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) + parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth),
      vertical: parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth),
      lineHeight: parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.18
    };
  }
  function measureTextExtents(textSpan) {
    const previousWidth = textSpan.style.width;
    textSpan.style.setProperty("white-space", "pre", "important");
    textSpan.style.setProperty("width", "max-content", "important");
    const singleLine = textSpan.scrollWidth;
    const words = textSpan.textContent.split(/\s+/).filter(Boolean);
    const originalText = textSpan.textContent;
    let longestWord = 0;
    for (const word of words) {
      textSpan.textContent = word;
      longestWord = Math.max(longestWord, textSpan.scrollWidth);
    }
    textSpan.textContent = originalText;
    textSpan.style.removeProperty("white-space");
    textSpan.style.removeProperty("width");
    if (previousWidth) textSpan.style.width = previousWidth;
    return { singleLine, longestWord };
  }
  function fitBubbleToText(overlay, boxWidth, boxHeight, shape) {
    const textSpan = overlay.querySelector(".manga-text-content");
    const maxWidth = Math.max(40, Math.min(document.documentElement.scrollWidth, window.innerWidth * 2) - 16);
    const maxHeight = Math.max(24, document.documentElement.scrollHeight - 16);
    if (!textSpan || !textSpan.textContent.trim()) {
      const width2 = Math.min(boxWidth, maxWidth);
      const height2 = Math.min(boxHeight, maxHeight);
      overlay.style.width = `${width2}px`;
      overlay.style.height = `${height2}px`;
      return { width: width2, height: height2 };
    }
    const slack = shape === "oval" ? { x: 1.3, y: 1.35 } : { x: 1, y: 1 };
    const chrome2 = getBubbleChrome(overlay);
    const { singleLine, longestWord } = measureTextExtents(textSpan);
    const maxContentWidth = Math.max(16, maxWidth - chrome2.horizontal);
    const targetRatio = Math.max(0.35, Math.min(3.2, boxWidth / Math.max(1, boxHeight)));
    let contentWidth = Math.sqrt(targetRatio * singleLine * chrome2.lineHeight * slack.x);
    contentWidth = Math.max(contentWidth, longestWord);
    contentWidth = Math.min(contentWidth, singleLine, maxContentWidth, Math.max(longestWord, (boxWidth - chrome2.horizontal) * slack.x));
    contentWidth = Math.max(16, Math.min(contentWidth, maxContentWidth));
    const measureHeight = (candidateContentWidth) => {
      overlay.style.width = `${candidateContentWidth + chrome2.horizontal}px`;
      overlay.style.height = "auto";
      return textSpan.scrollHeight;
    };
    let textHeight = measureHeight(contentWidth);
    for (let attempt = 0; attempt < 12 && textHeight * slack.y + chrome2.vertical > maxHeight && contentWidth < maxContentWidth; attempt++) {
      contentWidth = Math.min(maxContentWidth, contentWidth * 1.25);
      textHeight = measureHeight(contentWidth);
    }
    const width = Math.max(40, Math.min(maxWidth, contentWidth + chrome2.horizontal));
    const height = Math.max(24, Math.min(maxHeight, textHeight * slack.y + chrome2.vertical));
    overlay.style.width = `${width}px`;
    overlay.style.height = `${height}px`;
    shrinkTextToFitBubble(overlay);
    return { width, height };
  }
  function textOverflowsBubble(overlay) {
    const textSpan = overlay.querySelector(".manga-text-content");
    if (!textSpan) return false;
    const style = getComputedStyle(overlay);
    const availableWidth = overlay.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const availableHeight = overlay.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    return textSpan.scrollWidth > Math.ceil(availableWidth) + 1 || textSpan.scrollHeight > Math.ceil(availableHeight) + 1;
  }
  function shrinkTextToFitBubble(overlay) {
    let fontSize = parseFloat(getComputedStyle(overlay).fontSize);
    for (let attempt = 0; attempt < 40 && fontSize > 8 && textOverflowsBubble(overlay); attempt++) {
      fontSize -= 0.5;
      overlay.style.fontSize = `${fontSize}px`;
    }
  }
  function setAdaptiveBubbleContour(overlay, width, height, index) {
    const ratio = width / Math.max(1, height);
    const roundness = ratio > 1.8 ? 18 : ratio < 0.72 ? 42 : 30;
    const variation = index % 3;
    overlay.style.borderRadius = variation === 0 ? `${roundness}% ${Math.max(14, roundness - 6)}% ${roundness + 4}% ${Math.max(14, roundness - 3)}% / ${roundness + 3}% ${roundness}% ${Math.max(16, roundness - 5)}% ${roundness + 2}%` : variation === 1 ? `${Math.max(14, roundness - 4)}% ${roundness + 3}% ${roundness}% ${roundness + 5}% / ${roundness}% ${Math.max(16, roundness - 3)}% ${roundness + 4}% ${roundness}%` : `${roundness + 2}% ${roundness}% ${Math.max(14, roundness - 5)}% ${roundness + 4}% / ${Math.max(16, roundness - 4)}% ${roundness + 4}% ${roundness}% ${roundness + 2}%`;
  }
  function renderTranslationPanel(bubbles, mode, selectionRect) {
    document.querySelectorAll(".manga-display-panel, .manga-bubble-marker").forEach((element) => element.remove());
    const panel = document.createElement("aside");
    panel.className = `manga-display-panel manga-${mode}`;
    const heading = document.createElement("strong");
    heading.textContent = mode === "side-by-side" ? "Original / Translation" : "Manga Translation";
    panel.appendChild(heading);
    bubbles.forEach((bubble, index) => {
      const item = document.createElement("div");
      item.className = "manga-panel-item";
      if (mode === "side-by-side") {
        const number = document.createElement("b");
        number.textContent = `${index + 1}.`;
        const source = document.createElement("span");
        source.className = "manga-panel-source";
        source.textContent = bubble.source || "(OCR unavailable)";
        const translation = document.createElement("span");
        translation.className = "manga-panel-translation";
        translation.textContent = bubble.english;
        item.append(number, source, translation);
        renderBubbleMarker(bubble, selectionRect, index + 1);
      } else {
        if (mode === "side-panel-numbered") {
          const number = document.createElement("b");
          number.textContent = `${index + 1}.`;
          item.appendChild(number);
          renderBubbleMarker(bubble, selectionRect, index + 1);
        }
        const translation = document.createElement("span");
        translation.textContent = bubble.english;
        item.appendChild(translation);
      }
      panel.appendChild(item);
    });
    document.body.appendChild(panel);
  }
  function renderBubbleMarker(bubble, selectionRect, number) {
    const [ymin, xmin] = bubble.box_2d;
    const marker = document.createElement("span");
    marker.className = "manga-bubble-marker";
    marker.textContent = number;
    marker.style.left = `${selectionRect.left + xmin / 1e3 * selectionRect.width + window.scrollX}px`;
    marker.style.top = `${selectionRect.top + ymin / 1e3 * selectionRect.height + window.scrollY}px`;
    document.body.appendChild(marker);
  }
  function getFontFamily(fontFamily) {
    const fonts = {
      system: "system-ui, sans-serif",
      comic: '"Comic Sans MS", "Comic Sans", cursive',
      rounded: '"Trebuchet MS", sans-serif',
      serif: "Georgia, serif",
      condensed: '"Arial Narrow", "Roboto Condensed", sans-serif',
      typewriter: '"Courier New", monospace',
      classic: "Arial, Helvetica, sans-serif"
    };
    return fonts[fontFamily] || fonts.system;
  }
  function syncOverlayLabel(overlay, bubble) {
    overlay.setAttribute("aria-label", `Translated text: ${bubble.english}`);
  }
  async function updatePersistedBubble(overlay, bubble, { deleted = false } = {}) {
    const recordId = overlay.dataset.recordId;
    const bubbleId = overlay.dataset.bubbleId;
    if (!recordId || !bubbleId) return;
    const key = getSessionKey();
    const session = (await chrome.storage.local.get(key))[key];
    if (!Array.isArray(session?.records)) return;
    const record = session.records.find((candidate) => candidate.id === recordId);
    if (!record) return;
    const index = record.bubbles.findIndex((candidate) => candidate.id === bubbleId);
    if (index < 0) return;
    if (deleted) record.bubbles.splice(index, 1);
    else record.bubbles[index] = { ...record.bubbles[index], ...bubble };
    session.createdAt = Date.now();
    await chrome.storage.local.set({ [key]: session });
  }
  function refitEditedOverlay(overlay, bubble) {
    const rect = overlay.getBoundingClientRect();
    const centerLeft = rect.left + window.scrollX + rect.width / 2;
    const centerTop = rect.top + window.scrollY + rect.height / 2;
    const shape = overlay.classList.contains("manga-shape-oval") ? "oval" : overlay.classList.contains("manga-shape-rectangle") ? "rectangle" : "adaptive";
    const fitted = fitBubbleToText(overlay, rect.width, rect.height, shape);
    overlay.style.left = `${centerLeft - fitted.width / 2}px`;
    overlay.style.top = `${centerTop - fitted.height / 2}px`;
    clampOverlayToDocument(overlay);
    resolveBubbleOverlaps([...document.querySelectorAll(".manga-translation-overlay")]);
    void updatePersistedBubble(overlay, bubble);
  }
  function startInlineEdit(overlay, bubble) {
    const text = overlay.querySelector(".manga-text-content");
    if (!text || text.isContentEditable) return;
    const original = bubble.english;
    text.contentEditable = "plaintext-only";
    text.spellcheck = false;
    text.style.pointerEvents = "auto";
    overlay.classList.add("manga-overlay-editing");
    text.focus();
    getSelection()?.selectAllChildren(text);
    const finish = (commit) => {
      text.removeEventListener("keydown", onKeyDown);
      text.removeEventListener("blur", onBlur);
      text.contentEditable = "false";
      text.style.pointerEvents = "";
      overlay.classList.remove("manga-overlay-editing");
      const value = text.textContent.trim();
      if (commit && value) bubble.english = value;
      text.textContent = bubble.english;
      syncOverlayLabel(overlay, bubble);
      if (commit && value) refitEditedOverlay(overlay, bubble);
    };
    const onKeyDown = (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        finish(true);
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        text.textContent = original;
        finish(false);
      }
    };
    const onBlur = () => finish(true);
    text.addEventListener("keydown", onKeyDown);
    text.addEventListener("blur", onBlur, { once: true });
  }
  function showOverlayMenu(event, overlay, bubble) {
    event.preventDefault();
    document.querySelectorAll(".manga-overlay-menu").forEach((menu2) => menu2.remove());
    const menu = document.createElement("div");
    menu.className = "manga-overlay-menu";
    menu.setAttribute("role", "menu");
    const actions = [
      ["Copy translation", async () => {
        try {
          await navigator.clipboard.writeText(bubble.english);
          showToast("Translation copied.", "info", 2e3);
        } catch {
          showToast("Clipboard access was blocked by this page.", "error");
        }
      }],
      ["Edit", () => startInlineEdit(overlay, bubble)],
      ["Retry translation", () => retryBubble(overlay, bubble)],
      ["Show original OCR", () => showToast(bubble.source || "Original OCR is unavailable for this bubble.", "info", 8e3)],
      ["Delete", async () => {
        await updatePersistedBubble(overlay, bubble, { deleted: true });
        overlay.remove();
      }]
    ];
    const buttons = actions.map(([label, action]) => {
      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute("role", "menuitem");
      button.textContent = label;
      button.addEventListener("click", async () => {
        menu.remove();
        await action();
      });
      menu.appendChild(button);
      return button;
    });
    menu.addEventListener("keydown", (keyEvent) => {
      const index = buttons.indexOf(document.activeElement);
      if (keyEvent.key === "ArrowDown") {
        keyEvent.preventDefault();
        buttons[(index + 1) % buttons.length].focus();
      } else if (keyEvent.key === "ArrowUp") {
        keyEvent.preventDefault();
        buttons[(index - 1 + buttons.length) % buttons.length].focus();
      } else if (keyEvent.key === "Escape") {
        keyEvent.preventDefault();
        keyEvent.stopPropagation();
        menu.remove();
        overlay.focus();
      }
    });
    menu.style.left = `${event.clientX}px`;
    menu.style.top = `${event.clientY}px`;
    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(event.clientX, window.innerWidth - rect.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(event.clientY, window.innerHeight - rect.height - 8))}px`;
    buttons[0]?.focus();
  }
  var DRAG_THRESHOLD = 4;
  function enableOverlayDrag(overlay, bubble) {
    overlay.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      const startLeft = parseFloat(overlay.style.left);
      const startTop = parseFloat(overlay.style.top);
      const startClientX = event.clientX;
      const startClientY = event.clientY;
      let dragging = false;
      const move = (moveEvent) => {
        const deltaX = moveEvent.clientX - startClientX;
        const deltaY = moveEvent.clientY - startClientY;
        if (!dragging) {
          if (Math.hypot(deltaX, deltaY) < DRAG_THRESHOLD) return;
          dragging = true;
          overlay.classList.add("manga-overlay-dragging");
        }
        moveEvent.preventDefault();
        overlay.style.left = `${startLeft + deltaX}px`;
        overlay.style.top = `${startTop + deltaY}px`;
      };
      const stop = () => {
        window.removeEventListener("mousemove", move);
        if (!dragging) return;
        overlay.classList.remove("manga-overlay-dragging");
        clampOverlayToDocument(overlay);
        const rect = overlay.getBoundingClientRect();
        const captureLeft = Number(overlay.dataset.captureLeft);
        const captureTop = Number(overlay.dataset.captureTop);
        const captureWidth = Number(overlay.dataset.captureWidth);
        const captureHeight = Number(overlay.dataset.captureHeight);
        const [ymin, xmin, ymax, xmax] = bubble.box_2d;
        const expectedCenterLeft = captureLeft + (xmin + xmax) / 2e3 * captureWidth;
        const expectedCenterTop = captureTop + (ymin + ymax) / 2e3 * captureHeight;
        bubble.offsetX = rect.left + window.scrollX + rect.width / 2 - expectedCenterLeft;
        bubble.offsetY = rect.top + window.scrollY + rect.height / 2 - expectedCenterTop;
        void updatePersistedBubble(overlay, bubble);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", stop, { once: true });
    });
  }
  async function retryBubble(overlay, bubble) {
    if (!bubble.source) return showToast("Original OCR text is unavailable for this bubble.", "error");
    const requestId = crypto.randomUUID();
    const text = overlay.querySelector(".manga-text-content");
    overlay.classList.add("manga-overlay-pending");
    try {
      const response = await chrome.runtime.sendMessage({ action: "RETRY_BUBBLE", source: bubble.source, requestId });
      if (!response?.success) throw new Error(response?.error || "Retry failed.");
      bubble.english = response.data.translation;
      text.textContent = bubble.english;
      syncOverlayLabel(overlay, bubble);
      refitEditedOverlay(overlay, bubble);
    } catch (error) {
      showToast(`Retry failed: ${error.message}`, "error");
    } finally {
      overlay.classList.remove("manga-overlay-pending");
    }
  }
  function removeOverlaysInRegion(selectionRect) {
    const region = {
      left: selectionRect.left + window.scrollX,
      top: selectionRect.top + window.scrollY,
      right: selectionRect.left + window.scrollX + selectionRect.width,
      bottom: selectionRect.top + window.scrollY + selectionRect.height
    };
    document.querySelectorAll(".manga-translation-overlay").forEach((overlay) => {
      const rect = overlay.getBoundingClientRect();
      const overlayRegion = {
        left: rect.left + window.scrollX,
        top: rect.top + window.scrollY,
        right: rect.right + window.scrollX,
        bottom: rect.bottom + window.scrollY
      };
      const intersectionWidth = Math.max(0, Math.min(region.right, overlayRegion.right) - Math.max(region.left, overlayRegion.left));
      const intersectionHeight = Math.max(0, Math.min(region.bottom, overlayRegion.bottom) - Math.max(region.top, overlayRegion.top));
      const intersectionArea = intersectionWidth * intersectionHeight;
      const overlayArea = Math.max(1, rect.width * rect.height);
      if (intersectionArea / overlayArea >= 0.35) overlay.remove();
    });
  }
  function clampOverlayToDocument(overlay, margin = 8) {
    const rect = overlay.getBoundingClientRect();
    const documentWidth = Math.max(document.documentElement.scrollWidth, window.innerWidth);
    const documentHeight = Math.max(document.documentElement.scrollHeight, window.innerHeight);
    const maxLeft = Math.max(margin, documentWidth - rect.width - margin);
    const maxTop = Math.max(margin, documentHeight - rect.height - margin);
    const currentLeft = parseFloat(overlay.style.left);
    const currentTop = parseFloat(overlay.style.top);
    overlay.style.left = `${Math.max(margin, Math.min(Number.isFinite(currentLeft) ? currentLeft : margin, maxLeft))}px`;
    overlay.style.top = `${Math.max(margin, Math.min(Number.isFinite(currentTop) ? currentTop : margin, maxTop))}px`;
  }
  var MAX_OVERLAP_DRIFT_RATIO = 0.35;
  var OVERLAP_RESOLVE_PASSES = 12;
  var OVERLAP_CONDENSE_ROUNDS = 3;
  var OVERLAP_CONDENSE_SCALE = 0.85;
  function clampBubbleDrift(value, origin, extent) {
    const limit = Math.max(12, extent * MAX_OVERLAP_DRIFT_RATIO);
    return Math.min(origin + limit, Math.max(origin - limit, value));
  }
  function boxesCollide(first, second, padding) {
    return Math.min(first.left + first.width, second.left + second.width) - Math.max(first.left, second.left) + padding > 0 && Math.min(first.top + first.height, second.top + second.height) - Math.max(first.top, second.top) + padding > 0;
  }
  function condenseOverlay(box, scale) {
    const overlay = box.el;
    const textSpan = overlay.querySelector(".manga-text-content");
    const chrome2 = getBubbleChrome(overlay);
    const fontSize = parseFloat(getComputedStyle(overlay).fontSize);
    if (fontSize <= 9 && box.width <= 40) return false;
    overlay.style.fontSize = `${Math.max(9, fontSize * scale)}px`;
    const width = Math.max(40, box.width * scale);
    overlay.style.width = `${width}px`;
    overlay.style.height = "auto";
    const height = textSpan ? Math.max(24, textSpan.scrollHeight + chrome2.vertical) : box.height * scale;
    overlay.style.height = `${height}px`;
    shrinkTextToFitBubble(overlay);
    box.left += (box.width - width) / 2;
    box.top += (box.height - height) / 2;
    box.width = width;
    box.height = height;
    return true;
  }
  function resolveBubbleOverlaps(elements, padding = 6) {
    if (!elements || elements.length === 0) return;
    requestAnimationFrame(() => {
      const boxes = elements.filter((el) => el && document.body.contains(el) && el.querySelector(".manga-text-content")).map((el) => {
        const rect = el.getBoundingClientRect();
        const left = rect.left + window.scrollX;
        const top = rect.top + window.scrollY;
        return { el, left, top, width: rect.width, height: rect.height, originLeft: left, originTop: top };
      });
      if (boxes.length < 2) return;
      for (let pass = 0; pass < OVERLAP_RESOLVE_PASSES; pass++) {
        let moved = false;
        for (let i = 0; i < boxes.length; i++) {
          for (let j = i + 1; j < boxes.length; j++) {
            const anchor = boxes[i];
            const mover = boxes[j];
            const overlapX = Math.min(anchor.left + anchor.width, mover.left + mover.width) - Math.max(anchor.left, mover.left) + padding;
            const overlapY = Math.min(anchor.top + anchor.height, mover.top + mover.height) - Math.max(anchor.top, mover.top) + padding;
            if (overlapX <= 0 || overlapY <= 0) continue;
            if (overlapX < overlapY) {
              const direction = mover.left + mover.width / 2 < anchor.left + anchor.width / 2 ? -1 : 1;
              const next = clampBubbleDrift(mover.left + direction * overlapX, mover.originLeft, mover.width);
              if (Math.abs(next - mover.left) > 0.5) {
                mover.left = next;
                moved = true;
              }
            } else {
              const direction = mover.top + mover.height / 2 < anchor.top + anchor.height / 2 ? -1 : 1;
              const next = clampBubbleDrift(mover.top + direction * overlapY, mover.originTop, mover.height);
              if (Math.abs(next - mover.top) > 0.5) {
                mover.top = next;
                moved = true;
              }
            }
          }
        }
        if (!moved) break;
      }
      for (let round = 0; round < OVERLAP_CONDENSE_ROUNDS; round++) {
        const crowded = /* @__PURE__ */ new Set();
        for (let i = 0; i < boxes.length; i++) {
          for (let j = i + 1; j < boxes.length; j++) {
            if (boxesCollide(boxes[i], boxes[j], padding)) crowded.add(j);
          }
        }
        if (crowded.size === 0) break;
        let condensed = false;
        crowded.forEach((index) => {
          if (condenseOverlay(boxes[index], OVERLAP_CONDENSE_SCALE)) condensed = true;
        });
        if (!condensed) break;
      }
      for (let index = 1; index < boxes.length; index++) {
        const box = boxes[index];
        if (!boxes.slice(0, index).some((other) => boxesCollide(box, other, padding))) continue;
        const step = Math.max(12, Math.min(box.width, box.height) * 0.35);
        const candidates = [];
        for (let ring = 1; ring <= 4; ring++) {
          for (let x = -ring; x <= ring; x++) {
            candidates.push([x * step, -ring * step], [x * step, ring * step]);
          }
          for (let y = -ring + 1; y < ring; y++) {
            candidates.push([-ring * step, y * step], [ring * step, y * step]);
          }
        }
        const free = candidates.find(([deltaX, deltaY]) => {
          const candidate = { ...box, left: box.originLeft + deltaX, top: box.originTop + deltaY };
          return !boxes.slice(0, index).some((other) => boxesCollide(candidate, other, padding));
        });
        if (free) {
          box.left = box.originLeft + free[0];
          box.top = box.originTop + free[1];
        }
      }
      boxes.forEach((box) => {
        const overlay = box.el;
        if (!document.body.contains(overlay)) return;
        overlay.style.left = `${parseFloat(overlay.style.left) + (box.left - box.originLeft)}px`;
        overlay.style.top = `${parseFloat(overlay.style.top) + (box.top - box.originTop)}px`;
        clampOverlayToDocument(overlay);
      });
    });
  }

  // src/content/pageturn.js
  function clearAllOverlays({ cancelRequest = true, sessionKey = getSessionKey() } = {}) {
    state.pageGeneration += 1;
    if (cancelRequest && state.activeRequestId) {
      chrome.runtime.sendMessage({ action: "CANCEL_TRANSLATION", requestId: state.activeRequestId }).catch(() => {
      });
      state.activeRequestId = null;
    }
    state.activeStatus?.remove();
    state.activeStatus = null;
    document.querySelectorAll(".manga-translation-overlay").forEach((el) => el.remove());
    document.querySelectorAll(".manga-display-panel, .manga-overlay-menu, .manga-bubble-marker").forEach((el) => el.remove());
    void chrome.storage.local.remove(sessionKey);
    state.translatedImageSignature = null;
    state.activeCaptureRects = [];
    syncPageTurnWatchers();
  }
  function schedulePageTurnCheck() {
    clearTimeout(state.pageTurnCheckTimer);
    state.pageTurnCheckTimer = setTimeout(checkForPageTurn, 150);
  }
  async function initializePageTurnClearing() {
    const stored = await chrome.storage.local.get(["clearOverlaysOnPageTurn", "autoTranslateEnabled"]);
    state.clearOverlaysOnPageTurn = stored.clearOverlaysOnPageTurn === true;
    state.autoTranslateEnabled = stored.autoTranslateEnabled === true;
    chrome.storage.onChanged.addListener((changes) => {
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
    window.addEventListener("popstate", schedulePageTurnCheck);
    window.addEventListener("hashchange", schedulePageTurnCheck);
    if (window.navigation) window.navigation.addEventListener("navigate", schedulePageTurnCheck);
    syncPageTurnWatchers();
  }
  function syncPageTurnWatchers() {
    const needed = state.clearOverlaysOnPageTurn && hasVisibleOverlays() || state.autoTranslateEnabled;
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
      attributeFilter: ["src", "srcset"]
    });
    state.pageTurnWatchers = {
      intervalId: setInterval(() => {
        if (location.href !== state.observedPageUrl) schedulePageTurnCheck();
      }, 1e3),
      observer
    };
  }
  function hasVisibleOverlays() {
    return Boolean(document.querySelector(".manga-translation-overlay, .manga-display-panel"));
  }
  function checkForPageTurn() {
    const wantsCheck = state.clearOverlaysOnPageTurn && hasVisibleOverlays() || state.autoTranslateEnabled;
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
  function scheduleAutoTranslate() {
    if (!state.autoTranslateEnabled || state.activeRequestId) return;
    clearTimeout(state.autoTranslateTimer);
    state.autoTranslateTimer = setTimeout(() => {
      if (!state.autoTranslateEnabled || state.activeRequestId) return;
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - state.lastAutoCaptureAt < 2e3) return;
      state.lastAutoCaptureAt = now;
      processFullPageTranslation({ silent: true });
    }, 800);
  }
  function getTranslatedImageSignature() {
    const captures = state.activeCaptureRects.map((rect) => ({
      left: rect.left,
      top: rect.top,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height
    }));
    if (!captures.length) return "";
    return [...document.images].filter((image) => {
      const rect = image.getBoundingClientRect();
      const imageBounds = {
        left: rect.left + window.scrollX,
        top: rect.top + window.scrollY,
        right: rect.right + window.scrollX,
        bottom: rect.bottom + window.scrollY
      };
      return captures.some((capture) => imageBounds.left < capture.right && imageBounds.right > capture.left && imageBounds.top < capture.bottom && imageBounds.bottom > capture.top);
    }).map((image) => {
      const rect = image.getBoundingClientRect();
      return `${image.currentSrc || image.src}|${image.naturalWidth}x${image.naturalHeight}|${Math.round(rect.left)},${Math.round(rect.top)},${Math.round(rect.width)},${Math.round(rect.height)}`;
    }).concat([...document.querySelectorAll("canvas")].filter((canvas) => {
      const rect = canvas.getBoundingClientRect();
      const bounds = { left: rect.left + window.scrollX, top: rect.top + window.scrollY, right: rect.right + window.scrollX, bottom: rect.bottom + window.scrollY };
      return captures.some((capture) => bounds.left < capture.right && bounds.right > capture.left && bounds.top < capture.bottom && bounds.bottom > capture.top);
    }).map((canvas) => {
      const rect = canvas.getBoundingClientRect();
      return `canvas|${canvas.width}x${canvas.height}|${Math.round(rect.left)},${Math.round(rect.top)},${Math.round(rect.width)},${Math.round(rect.height)}`;
    })).sort().join("\n");
  }

  // src/shared/hash.js
  function hashString(value) {
    let first = 2166136261;
    let second = 2654435761;
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      first = Math.imul(first ^ code, 16777619);
      second = Math.imul(second + code, 2654435761) ^ second >>> 15;
    }
    return `${(first >>> 0).toString(36)}${(second >>> 0).toString(36)}${value.length.toString(36)}`;
  }

  // src/content/session.js
  function getSessionKey() {
    return `pageSession:${hashString(location.href)}`;
  }
  async function savePageSession(bubbles, selectionRect, config, recordId = crypto.randomUUID()) {
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
    const records = Array.isArray(existing?.records) ? existing.records : existing?.bubbles && existing?.rect ? [{ bubbles: existing.bubbles, rect: existing.rect, config: existing.config }] : [];
    const retainedRecords = records.filter((record) => !rectsSubstantiallyOverlap2(record.rect, rect));
    retainedRecords.push({ id: recordId, bubbles, rect, config: renderingConfig });
    await chrome.storage.local.set({
      [key]: { records: retainedRecords.slice(-20), createdAt: Date.now() }
    });
    state.renderedSessionKey = key;
  }
  async function restorePageSession() {
    const { persistOverlays } = await chrome.storage.local.get("persistOverlays");
    if (persistOverlays === false) return;
    const key = getSessionKey();
    const session = (await chrome.storage.local.get(key))[key];
    if (!session) return;
    const records = Array.isArray(session.records) ? session.records : session.bubbles && session.rect ? [{ bubbles: session.bubbles, rect: session.rect, config: session.config }] : [];
    const overlays = [];
    records.forEach((record) => {
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
  function rememberCaptureRect(selectionRect) {
    const rect = {
      left: selectionRect.left + window.scrollX,
      top: selectionRect.top + window.scrollY,
      width: selectionRect.width,
      height: selectionRect.height
    };
    state.activeCaptureRects = state.activeCaptureRects.filter((existing) => !rectsSubstantiallyOverlap2(existing, rect));
    state.activeCaptureRects.push(rect);
  }
  function rectsSubstantiallyOverlap2(first, second) {
    return rectsSubstantiallyOverlap(first, second, 0.35);
  }
  function refreshPageTurnBaseline() {
    state.observedPageUrl = location.href;
    state.translatedImageSignature = state.clearOverlaysOnPageTurn ? getTranslatedImageSignature() : null;
    syncPageTurnWatchers();
  }

  // src/content/floatpanel.js
  async function initFloatPanel() {
    const stored = await chrome.storage.local.get(["showFloatPanel", "floatPanelX", "floatPanelY", "autoTranslateEnabled"]);
    let panel = null;
    function applyPosition(x, y) {
      const rect = panel.getBoundingClientRect();
      const maxX = window.innerWidth - rect.width - 8;
      const maxY = window.innerHeight - rect.height - 8;
      panel.style.left = `${Math.max(8, Math.min(maxX, x))}px`;
      panel.style.top = `${Math.max(8, Math.min(maxY, y))}px`;
    }
    function syncAutoButton(btn) {
      btn.classList.toggle("manga-fp-active", state.autoTranslateEnabled);
      btn.title = `Auto Translate: ${state.autoTranslateEnabled ? "ON" : "OFF"}`;
      btn.setAttribute("aria-pressed", String(state.autoTranslateEnabled));
    }
    function build() {
      if (panel) return;
      panel = document.createElement("div");
      panel.id = "manga-float-panel";
      const drag = document.createElement("span");
      drag.className = "manga-fp-drag";
      drag.textContent = "\u283F";
      drag.title = "Drag to move";
      const retranslateBtn = document.createElement("button");
      retranslateBtn.className = "manga-fp-btn";
      retranslateBtn.textContent = "\u{1F504}";
      retranslateBtn.title = "Translate visible screen";
      retranslateBtn.addEventListener("click", () => {
        if (state.activeRequestId) return;
        processFullPageTranslation();
      });
      const autoBtn = document.createElement("button");
      autoBtn.className = "manga-fp-btn";
      autoBtn.textContent = "\u26A1";
      syncAutoButton(autoBtn);
      autoBtn.addEventListener("click", async () => {
        const next = !state.autoTranslateEnabled;
        await chrome.storage.local.set({ autoTranslateEnabled: next });
        chrome.runtime.sendMessage({ action: "SET_AUTO_TRANSLATE", enabled: next }).catch(() => {
        });
      });
      const closeBtn = document.createElement("button");
      closeBtn.className = "manga-fp-btn";
      closeBtn.textContent = "\u2715";
      closeBtn.title = "Hide panel (re-enable in Settings)";
      closeBtn.addEventListener("click", async () => {
        await chrome.storage.local.set({ showFloatPanel: false });
      });
      panel.append(drag, retranslateBtn, autoBtn, closeBtn);
      document.documentElement.appendChild(panel);
      applyPosition(
        stored.floatPanelX ?? window.innerWidth - 170,
        stored.floatPanelY ?? window.innerHeight - 90
      );
      drag.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        drag.setPointerCapture(event.pointerId);
        const rect = panel.getBoundingClientRect();
        const offsetX = event.clientX - rect.left;
        const offsetY = event.clientY - rect.top;
        const onMove = (moveEvent) => {
          applyPosition(moveEvent.clientX - offsetX, moveEvent.clientY - offsetY);
        };
        const onUp = (upEvent) => {
          drag.removeEventListener("pointermove", onMove);
          drag.removeEventListener("pointerup", onUp);
          drag.removeEventListener("pointercancel", onUp);
          const r = panel.getBoundingClientRect();
          const snapX = r.left + r.width / 2 < window.innerWidth / 2 ? 8 : window.innerWidth - r.width - 8;
          applyPosition(snapX, r.top);
          const finalRect = panel.getBoundingClientRect();
          void chrome.storage.local.set({ floatPanelX: finalRect.left, floatPanelY: finalRect.top });
        };
        drag.addEventListener("pointermove", onMove);
        drag.addEventListener("pointerup", onUp);
        drag.addEventListener("pointercancel", onUp);
      });
    }
    function teardown() {
      panel?.remove();
      panel = null;
    }
    if (stored.showFloatPanel === true) build();
    chrome.storage.onChanged.addListener((changes) => {
      if (changes.showFloatPanel) {
        if (changes.showFloatPanel.newValue === true) build();
        else teardown();
      }
      if (changes.autoTranslateEnabled && panel) {
        const autoBtn = panel.querySelectorAll(".manga-fp-btn")[1];
        if (autoBtn) syncAutoButton(autoBtn);
      }
    });
  }

  // src/content/index.js
  state.renderedSessionKey = getSessionKey();
  restorePageSession();
  initializePageTurnClearing();
  initFloatPanel();
  document.addEventListener("mousedown", (event) => {
    const menu = document.querySelector(".manga-overlay-menu");
    if (menu && !menu.contains(event.target)) menu.remove();
  }, true);
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const snipActive = state.isSelecting || !!document.querySelector(".manga-capture-shield");
    const hasExtensionUi = !!document.querySelector(
      ".manga-translation-overlay, .manga-display-panel, .manga-bubble-marker, .manga-overlay-menu"
    );
    if (!snipActive && !hasExtensionUi && !state.activeRequestId) return;
    cancelSnipMode();
    clearAllOverlays();
  });
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "START_SNIP") {
      enableSnipMode("translate");
    } else if (request.action === "START_FULL_PAGE") {
      processFullPageTranslation();
    } else if (request.action === "CLEAR_OVERLAYS") {
      clearAllOverlays();
    } else if (request.action === "SAVE_REGION_SCREENSHOT") {
      enableSnipMode("screenshot");
    } else if (request.action === "SAVE_PAGE_SCREENSHOT") {
      saveVisibleScreenshot();
    } else if (request.action === "TRANSLATION_PROGRESS" && request.requestId === state.activeRequestId) {
      updateStatus(request.message);
    } else if (request.action === "TRANSLATION_PARTIAL" && request.requestId === state.activeRequestId) {
      renderPartialBubble(request.region);
    }
  });
})();
