document.addEventListener('DOMContentLoaded', async () => {
  const snipBtn = document.getElementById('snipBtn');
  const fullPageBtn = document.getElementById('fullPageBtn');
  const saveRegionBtn = document.getElementById('saveRegionBtn');
  const savePageBtn = document.getElementById('savePageBtn');
  const settingsBtn = document.getElementById('settingsBtn');
  
  const bubbleScaleModeSelect = document.getElementById('bubbleScaleMode');
  const manualControls = document.getElementById('manualControls');
  const widthScaleInput = document.getElementById('widthScale');
  const heightScaleInput = document.getElementById('heightScale');
  const bubbleTypeSelect = document.getElementById('bubbleType');
  const displayModeSelect = document.getElementById('displayMode');
  const readingOrderSelect = document.getElementById('readingOrder');
  const clearOverlaysOnPageTurnInput = document.getElementById('clearOverlaysOnPageTurn');

  // Load saved preferences
  const config = await chrome.storage.local.get([
    'bubbleScaleMode', 'widthScale', 'heightScale', 'bubbleType', 'displayMode', 'readingOrder',
    'clearOverlaysOnPageTurn', 'autoTranslateEnabled', 'showFloatPanel'
  ]);

  // Restores a stored value only when it maps to a real <option>, so the UI can never
  // display one mode while storage still holds another. Legacy values are migrated.
  function restoreSelect(select, storedValue, { fallback, legacy = {} } = {}) {
    const value = legacy[storedValue] ?? storedValue;
    const isValid = [...select.options].some(option => option.value === value);
    select.value = isValid ? value : (fallback ?? select.options[0].value);
    return select.value !== storedValue;
  }

  function restoreNumber(input, storedValue, fallback) {
    const parsed = Number.parseInt(storedValue, 10);
    const min = Number.parseInt(input.min, 10);
    const max = Number.parseInt(input.max, 10);
    input.value = Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
  }

  const migrated = [
    restoreSelect(bubbleScaleModeSelect, config.bubbleScaleMode, { fallback: 'auto' }),
    restoreSelect(bubbleTypeSelect, config.bubbleType, { fallback: 'adaptive' }),
    restoreSelect(displayModeSelect, config.displayMode, {
      fallback: 'overlay',
      legacy: {
        'subtitle-list': 'side-panel-numbered',
        'side-panel': 'side-panel-numbered',
        'manual-numbered': 'side-panel-numbered'
      }
    }),
    restoreSelect(readingOrderSelect, config.readingOrder, { fallback: 'rtl' })
  ].some(Boolean);

  restoreNumber(widthScaleInput, config.widthScale, 150);
  restoreNumber(heightScaleInput, config.heightScale, 100);
  clearOverlaysOnPageTurnInput.checked = config.clearOverlaysOnPageTurn === true;

  // Toggle visibility of width/height inputs based on selected mode
  function updateVisibility() {
    manualControls.style.display = bubbleScaleModeSelect.value === 'manual' ? 'block' : 'none';
  }
  updateVisibility();

  async function saveSettings() {
    const normalizedWidthScale = Math.max(50, Math.min(400, parseInt(widthScaleInput.value, 10) || 150));
    const normalizedHeightScale = Math.max(50, Math.min(400, parseInt(heightScaleInput.value, 10) || 100));
    widthScaleInput.value = normalizedWidthScale;
    heightScaleInput.value = normalizedHeightScale;

    await chrome.storage.local.set({
      bubbleScaleMode: bubbleScaleModeSelect.value,
      widthScale: normalizedWidthScale,
      heightScale: normalizedHeightScale,
      bubbleType: bubbleTypeSelect.value,
      displayMode: displayModeSelect.value,
      readingOrder: readingOrderSelect.value,
      clearOverlaysOnPageTurn: clearOverlaysOnPageTurnInput.checked
    });
  }

  // Persist immediately when any stored value was legacy or invalid, so the content
  // script and this popup can never disagree about the active mode.
  if (migrated) await saveSettings();

  async function sendActionToActiveTab(action) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('No active tab found.');
    await chrome.tabs.sendMessage(tab.id, { action });
  }

  bubbleScaleModeSelect.addEventListener('change', () => {
    updateVisibility();
    saveSettings();
  });
  widthScaleInput.addEventListener('change', saveSettings);
  heightScaleInput.addEventListener('change', saveSettings);
  bubbleTypeSelect.addEventListener('change', saveSettings);
  displayModeSelect.addEventListener('change', saveSettings);
  readingOrderSelect.addEventListener('change', saveSettings);
  clearOverlaysOnPageTurnInput.addEventListener('change', saveSettings);

  /**
   * Wires an action button. On failure the label reverts after a moment instead of
   * being permanently overwritten with "Unavailable on this page".
   */
  function wireAction(button, action, { save = false } = {}) {
    button.addEventListener('click', async () => {
      if (save) await saveSettings();
      const originalLabel = button.textContent;
      try {
        await sendActionToActiveTab(action);
        window.close();
      } catch {
        button.textContent = 'Unavailable on this page';
        button.disabled = true;
        setTimeout(() => {
          button.textContent = originalLabel;
          button.disabled = false;
        }, 2500);
      }
    });
  }

  wireAction(snipBtn, 'START_SNIP', { save: true });
  wireAction(fullPageBtn, 'START_FULL_PAGE', { save: true });
  wireAction(saveRegionBtn, 'SAVE_REGION_SCREENSHOT');
  wireAction(savePageBtn, 'SAVE_PAGE_SCREENSHOT');

  // Auto-translate toggle: persisted in storage (content scripts react via
  // storage.onChanged) and mirrored to the toolbar badge via the service worker.
  const autoTranslateBtn = document.getElementById('autoTranslateBtn');
  function refreshAutoBtn(enabled) {
    autoTranslateBtn.textContent = `Auto Translate: ${enabled ? 'ON' : 'OFF'}`;
    autoTranslateBtn.classList.toggle('btn-accent', enabled);
    autoTranslateBtn.classList.toggle('btn-secondary', !enabled);
  }
  refreshAutoBtn(config.autoTranslateEnabled === true);
  autoTranslateBtn.addEventListener('click', async () => {
    const enabled = !(await chrome.storage.local.get('autoTranslateEnabled')).autoTranslateEnabled;
    await chrome.storage.local.set({ autoTranslateEnabled: enabled });
    refreshAutoBtn(enabled);
    chrome.runtime.sendMessage({ action: 'SET_AUTO_TRANSLATE', enabled }).catch(() => {});
  });

  // Floating-panel toggle: same storage key the options page uses. The content script
  // reacts via storage.onChanged, so no message needs to be sent.
  const floatPanelBtn = document.getElementById('floatPanelBtn');
  function refreshFloatBtn(enabled) {
    floatPanelBtn.textContent = `Floating Panel: ${enabled ? 'ON' : 'OFF'}`;
    floatPanelBtn.classList.toggle('btn-accent', enabled);
    floatPanelBtn.classList.toggle('btn-secondary', !enabled);
  }
  refreshFloatBtn(config.showFloatPanel === true);
  floatPanelBtn.addEventListener('click', async () => {
    const enabled = !(await chrome.storage.local.get('showFloatPanel')).showFloatPanel;
    await chrome.storage.local.set({ showFloatPanel: enabled });
    refreshFloatBtn(enabled);
  });

  // Chrome silently drops a suggested key when it conflicts with an existing binding,
  // and users can remap freely, so read the real bindings instead of hardcoding labels.
  async function renderShortcutLabels() {
    const commands = await chrome.commands.getAll();
    const byName = new Map(commands.map(command => [command.name, command.shortcut]));
    document.querySelectorAll('button[data-command]').forEach(button => {
      const shortcut = byName.get(button.dataset.command);
      const target = button.querySelector('.shortcut');
      if (!target) return;
      target.textContent = shortcut ? `(${shortcut})` : '';
      const label = button.textContent.replace(/\s+/g, ' ').trim();
      button.setAttribute('aria-label', shortcut ? `${label.replace(`(${shortcut})`, '').trim()}, shortcut ${shortcut}` : label);
    });
  }
  renderShortcutLabels();

  document.getElementById('shortcutsLink').addEventListener('click', event => {
    event.preventDefault();
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  });

  settingsBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
  });
});