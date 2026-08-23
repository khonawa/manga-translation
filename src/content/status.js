// Status UI: toasts, status labels, and the cancel button shared by the snip
// overlay and the full-page status banner.

import { state } from './state.js';
import { cancelSnipMode } from './snip.js';

export function addCancelButton(container) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Cancel';
  button.style.marginLeft = '10px';
  button.style.cursor = 'pointer';
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (state.activeRequestId) {
      chrome.runtime.sendMessage({ action: 'CANCEL_TRANSLATION', requestId: state.activeRequestId }).catch(() => {});
      state.activeRequestId = null;
      state.pageGeneration += 1;
    }
    state.activeStatus = null;
    cancelSnipMode();
    container.remove();
  });
  container.appendChild(button);
}

/**
 * Non-blocking replacement for alert(). Chrome increasingly throttles modal dialogs
 * from content scripts, and they cannot be styled to match the rest of the UI.
 */
export function showToast(message, variant = 'info', duration = 5000) {
  document.querySelector('.manga-toast')?.remove();
  const toast = document.createElement('div');
  toast.className = `manga-toast manga-toast-${variant}`;
  toast.setAttribute('role', variant === 'error' ? 'alert' : 'status');
  toast.setAttribute('aria-live', variant === 'error' ? 'assertive' : 'polite');

  const text = document.createElement('span');
  text.className = 'manga-toast-text';
  text.textContent = message;

  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'manga-toast-close';
  dismiss.setAttribute('aria-label', 'Dismiss message');
  dismiss.textContent = '×';
  dismiss.addEventListener('click', () => toast.remove());

  toast.append(text, dismiss);
  document.body.appendChild(toast);
  if (duration) setTimeout(() => toast.remove(), duration);
  return toast;
}

export function setStatusText(container, message) {
  let label = container.querySelector('.manga-status-label');
  if (!label) {
    label = document.createElement('span');
    label.className = 'manga-status-label';
    // Insert before the cancel button when one is already present.
    container.insertBefore(label, container.firstChild);
  }
  label.textContent = `${message} `;
  return label;
}

export function updateStatus(message) {
  if (!state.activeStatus) return;
  setStatusText(state.activeStatus, message);
}
