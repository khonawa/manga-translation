// Region snipping: the crosshair selection box, mouse handlers, and the capture
// shield that blocks page interactions while a region is being drawn.

import { state } from './state.js';
import { setStatusText, addCancelButton } from './status.js';
import { cropNativeScreenshot } from './capture.js';
import { processImageWithAI } from './translate.js';
import { downloadImage } from './screenshot.js';

export function cancelSnipMode() {
  state.isSelecting = false;
  window.removeEventListener('click', preventClickPropagation, true);
  window.removeEventListener('mousedown', onMouseDown, true);
  window.removeEventListener('mousemove', onMouseMove, true);
  window.removeEventListener('mouseup', onMouseUp, true);
  document.body.style.cursor = '';
  document.documentElement.style.cursor = '';
  document.documentElement.classList.remove('manga-capture-active');
  document.querySelector('.manga-capture-shield')?.remove();

  if (state.overlayDiv && !state.overlayDiv.classList.contains('manga-translation-overlay')) {
    state.overlayDiv.remove();
  }
  state.overlayDiv = null;
}

export function preventClickPropagation(e) {
  e.preventDefault();
  e.stopPropagation();
  return false;
}

export function enableSnipMode(purpose = 'translate') {
  cancelSnipMode();
  state.selectionPurpose = purpose;
  document.body.style.cursor = 'crosshair';
  document.documentElement.style.cursor = 'crosshair';
  document.documentElement.classList.add('manga-capture-active');
  installCaptureShield();

  window.addEventListener('click', preventClickPropagation, { capture: true, once: true });
  window.addEventListener('mousedown', onMouseDown, { capture: true, once: true });
}

export function installCaptureShield() {
  document.querySelector('.manga-capture-shield')?.remove();
  const shield = document.createElement('div');
  shield.className = 'manga-capture-shield';
  shield.addEventListener('click', preventClickPropagation, true);
  shield.addEventListener('dragstart', preventClickPropagation, true);
  shield.addEventListener('contextmenu', preventClickPropagation, true);
  document.documentElement.appendChild(shield);
  return shield;
}

export function onMouseDown(e) {
  e.preventDefault();
  e.stopPropagation();

  state.isSelecting = true;
  state.startX = e.clientX;
  state.startY = e.clientY;

  state.overlayDiv = document.createElement('div');
  state.overlayDiv.style.position = 'fixed';
  state.overlayDiv.style.border = '2px dashed #0066ff';
  state.overlayDiv.style.backgroundColor = 'rgba(0, 102, 255, 0.15)';
  state.overlayDiv.style.zIndex = '9999999';
  state.overlayDiv.style.pointerEvents = 'none';
  state.overlayDiv.style.left = `${state.startX}px`;
  state.overlayDiv.style.top = `${state.startY}px`;
  document.body.appendChild(state.overlayDiv);

  window.addEventListener('mousemove', onMouseMove, { capture: true });
  window.addEventListener('mouseup', onMouseUp, { capture: true, once: true });
}

export function onMouseMove(e) {
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

export async function onMouseUp(e) {
  e.preventDefault();
  e.stopPropagation();

  if (!state.isSelecting) return;
  state.isSelecting = false;

  window.removeEventListener('mousemove', onMouseMove, true);
  document.body.style.cursor = '';
  document.documentElement.style.cursor = '';
  document.documentElement.classList.remove('manga-capture-active');
  document.querySelector('.manga-capture-shield')?.remove();

  if (!state.overlayDiv) return;

  const rect = state.overlayDiv.getBoundingClientRect();

  if (rect.width < 20 || rect.height < 20) {
    state.overlayDiv.remove();
    state.overlayDiv = null;
    return;
  }

  state.overlayDiv.style.pointerEvents = 'auto';
  state.overlayDiv.style.border = '2px solid #ffaa00';
  state.overlayDiv.style.backgroundColor = 'rgba(0, 0, 0, 0.85)';
  setStatusText(state.overlayDiv, 'Preparing image...');
  state.overlayDiv.style.color = "#fff";
  state.overlayDiv.style.fontWeight = "bold";
  state.overlayDiv.style.display = "flex";
  state.overlayDiv.style.alignItems = "center";
  state.overlayDiv.style.justifyContent = "center";

  try {
    state.activeStatus = state.overlayDiv;
    const base64Image = await cropNativeScreenshot(rect, {
      includeTranslationOverlays: state.selectionPurpose === 'screenshot'
    });
    if (state.selectionPurpose === 'screenshot') {
      await downloadImage(base64Image, 'manga-region');
      state.overlayDiv.remove();
      state.overlayDiv = null;
      return;
    }
    addCancelButton(state.overlayDiv);
    await processImageWithAI(base64Image, rect, state.overlayDiv);
  } catch (err) {
    console.error("Manga Translator Error:", err);
    state.overlayDiv.style.backgroundColor = "rgba(255, 0, 0, 0.5)";
    setStatusText(state.overlayDiv, 'API Error');
    setTimeout(() => state.overlayDiv?.remove(), 4000);
  }
}
