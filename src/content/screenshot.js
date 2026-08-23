// Screenshot saving: full visible-tab capture and the shared image-download helper.

import { showToast } from './status.js';

export async function saveVisibleScreenshot() {
  const response = await chrome.runtime.sendMessage({ action: 'CAPTURE_TAB' });
  if (!response?.dataUrl) return showToast(response?.error || 'Failed to capture the visible page.', 'error');
  try {
    await downloadImage(response.dataUrl, 'manga-visible-page');
    showToast('Screenshot saved.', 'info', 2500);
  } catch (error) {
    showToast(error.message, 'error');
  }
}

export async function downloadImage(dataUrl, prefix) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const response = await chrome.runtime.sendMessage({ action: 'DOWNLOAD_IMAGE', dataUrl, filename: `${prefix}-${stamp}.jpg` });
  if (!response?.success) throw new Error(response?.error || 'Screenshot download failed.');
}
