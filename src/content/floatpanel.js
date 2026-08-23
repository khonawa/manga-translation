// Floating touch control panel: a small draggable pill with re-translate,
// auto-translate toggle, and dismiss buttons. Position persists across sessions.

import { state } from './state.js';
import { processFullPageTranslation } from './capture.js';

export async function initFloatPanel() {
  const stored = await chrome.storage.local.get(['showFloatPanel', 'floatPanelX', 'floatPanelY', 'autoTranslateEnabled']);
  let panel = null;

  function applyPosition(x, y) {
    const rect = panel.getBoundingClientRect();
    const maxX = window.innerWidth - rect.width - 8;
    const maxY = window.innerHeight - rect.height - 8;
    panel.style.left = `${Math.max(8, Math.min(maxX, x))}px`;
    panel.style.top = `${Math.max(8, Math.min(maxY, y))}px`;
  }

  function syncAutoButton(btn) {
    btn.classList.toggle('manga-fp-active', state.autoTranslateEnabled);
    btn.title = `Auto Translate: ${state.autoTranslateEnabled ? 'ON' : 'OFF'}`;
    btn.setAttribute('aria-pressed', String(state.autoTranslateEnabled));
  }

  function build() {
    if (panel) return;
    panel = document.createElement('div');
    panel.id = 'manga-float-panel';

    const drag = document.createElement('span');
    drag.className = 'manga-fp-drag';
    drag.textContent = '⠿';
    drag.title = 'Drag to move';

    const retranslateBtn = document.createElement('button');
    retranslateBtn.className = 'manga-fp-btn';
    retranslateBtn.textContent = '🔄';
    retranslateBtn.title = 'Translate visible screen';
    retranslateBtn.addEventListener('click', () => {
      if (state.activeRequestId) return;
      processFullPageTranslation();
    });

    const autoBtn = document.createElement('button');
    autoBtn.className = 'manga-fp-btn';
    autoBtn.textContent = '⚡';
    syncAutoButton(autoBtn);
    autoBtn.addEventListener('click', async () => {
      const next = !state.autoTranslateEnabled;
      await chrome.storage.local.set({ autoTranslateEnabled: next });
      chrome.runtime.sendMessage({ action: 'SET_AUTO_TRANSLATE', enabled: next }).catch(() => {});
    });

    const closeBtn = document.createElement('button');
    closeBtn.className = 'manga-fp-btn';
    closeBtn.textContent = '✕';
    closeBtn.title = 'Hide panel (re-enable in Settings)';
    closeBtn.addEventListener('click', async () => {
      await chrome.storage.local.set({ showFloatPanel: false });
    });

    panel.append(drag, retranslateBtn, autoBtn, closeBtn);
    document.documentElement.appendChild(panel);
    applyPosition(
      stored.floatPanelX ?? window.innerWidth - 170,
      stored.floatPanelY ?? window.innerHeight - 90
    );

    // Pointer-capture drag with edge snap.
    drag.addEventListener('pointerdown', event => {
      event.preventDefault();
      drag.setPointerCapture(event.pointerId);
      const rect = panel.getBoundingClientRect();
      const offsetX = event.clientX - rect.left;
      const offsetY = event.clientY - rect.top;

      const onMove = moveEvent => {
        applyPosition(moveEvent.clientX - offsetX, moveEvent.clientY - offsetY);
      };
      const onUp = upEvent => {
        drag.removeEventListener('pointermove', onMove);
        drag.removeEventListener('pointerup', onUp);
        drag.removeEventListener('pointercancel', onUp);
        // Snap to the nearest horizontal edge.
        const r = panel.getBoundingClientRect();
        const snapX = (r.left + r.width / 2) < window.innerWidth / 2 ? 8 : window.innerWidth - r.width - 8;
        applyPosition(snapX, r.top);
        const finalRect = panel.getBoundingClientRect();
        void chrome.storage.local.set({ floatPanelX: finalRect.left, floatPanelY: finalRect.top });
      };
      drag.addEventListener('pointermove', onMove);
      drag.addEventListener('pointerup', onUp);
      drag.addEventListener('pointercancel', onUp);
    });
  }

  function teardown() {
    panel?.remove();
    panel = null;
  }

  if (stored.showFloatPanel === true) build();

  chrome.storage.onChanged.addListener(changes => {
    if (changes.showFloatPanel) {
      if (changes.showFloatPanel.newValue === true) build();
      else teardown();
    }
    if (changes.autoTranslateEnabled && panel) {
      const autoBtn = panel.querySelectorAll('.manga-fp-btn')[1];
      if (autoBtn) syncAutoButton(autoBtn);
    }
  });
}
