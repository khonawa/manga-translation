import { PROVIDERS, getProvider } from './src/shared/providers.js';

const fields = {
  provider: document.getElementById('provider'), apiEndpoint: document.getElementById('endpoint'), apiKey: document.getElementById('apiKey'), apiModel: document.getElementById('model'),
  sourceLanguage: document.getElementById('sourceLanguage'), targetLanguage: document.getElementById('targetLanguage'), separateStages: document.getElementById('separateStages'), persistOverlays: document.getElementById('persistOverlays'),
  apiKeySessionOnly: document.getElementById('apiKeySessionOnly'), customInputRate: document.getElementById('customInputRate'), customOutputRate: document.getElementById('customOutputRate'),
  fontSizeMode: document.getElementById('fontSizeMode'), manualFontSize: document.getElementById('manualFontSize'), fontFamily: document.getElementById('fontFamily'), bubbleBgColor: document.getElementById('bubbleBgColor'), textColor: document.getElementById('textColor')
};
const status = document.getElementById('status'); const onboarding = document.getElementById('onboarding'); const usageSummary = document.getElementById('usageSummary');
let saveTimer; buildProviderOptions(); initialize();

// The provider list lives in one place so the options page, popup, and worker cannot drift apart.
function buildProviderOptions() {
  fields.provider.replaceChildren(...Object.entries(PROVIDERS).map(([value, preset]) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = preset.label;
    return option;
  }));
}

async function initialize() {
  const [stored, session] = await Promise.all([chrome.storage.local.get([...Object.keys(fields), 'onboardingComplete', 'usageHistory']), chrome.storage.session.get('apiKey')]);
  if (session.apiKey) stored.apiKey = session.apiKey;
  Object.entries(fields).forEach(([key, input]) => { if (stored[key] === undefined) return; if (input.type === 'checkbox') input.checked = stored[key]; else input.value = stored[key]; });
  onboarding.hidden = stored.onboardingComplete === true; updateVisibility(); renderUsage(stored.usageHistory || []);
}
fields.provider.addEventListener('change', () => {
  const preset = getProvider(fields.provider.value);
  fields.apiEndpoint.value = preset.endpoint;
  fields.apiModel.value = preset.model;
  autoSave();
});
fields.fontSizeMode.addEventListener('change', () => { updateVisibility(); autoSave(); });
fields.persistOverlays.addEventListener('change', async () => {
  await autoSave();
  if (!fields.persistOverlays.checked) {
    const stored = await chrome.storage.local.get(null);
    await chrome.storage.local.remove(Object.keys(stored).filter(key => key.startsWith('pageSession:')));
  }
});
[fields.fontFamily, fields.sourceLanguage, fields.targetLanguage, fields.separateStages].forEach(input => input.addEventListener('change', autoSave));
Object.values(fields).forEach(input => input.addEventListener('input', scheduleSave));
document.getElementById('toggleKey').addEventListener('click', event => { const reveal = fields.apiKey.type === 'password'; fields.apiKey.type = reveal ? 'text' : 'password'; event.currentTarget.textContent = reveal ? 'Hide key' : 'Show key'; });
document.getElementById('clearKey').addEventListener('click', () => { fields.apiKey.value = ''; autoSave(); });
document.getElementById('testConnection').addEventListener('click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  status.textContent = 'Testing connection...';
  try {
    await autoSave();
    const response = await chrome.runtime.sendMessage({ action: 'TEST_CONNECTION', config: getApiValues() });
    if (!response?.success) { status.textContent = response?.error || 'Connection failed.'; return; }
    await chrome.storage.local.set({ onboardingComplete: true });
    onboarding.hidden = true;
    status.textContent = `Connected to ${response.data.model}`;
  } catch (error) {
    status.textContent = `Connection failed: ${error.message}`;
  } finally {
    button.disabled = false;
  }
});
function getApiValues() { return { provider: fields.provider.value, apiEndpoint: fields.apiEndpoint.value.trim(), apiKey: fields.apiKey.value.trim(), apiModel: fields.apiModel.value.trim(), sourceLanguage: fields.sourceLanguage.value, targetLanguage: fields.targetLanguage.value, separateStages: fields.separateStages.checked }; }
async function autoSave() {
  const api = getApiValues(); if (api.apiEndpoint) { try { const url = new URL(api.apiEndpoint); if (!['http:', 'https:'].includes(url.protocol)) throw new Error(); } catch { status.textContent = 'Enter a valid HTTP(S) endpoint'; return; } }
  if (fields.apiKeySessionOnly.checked) { await chrome.storage.session.set({ apiKey: api.apiKey }); await chrome.storage.local.remove('apiKey'); }
  else { await chrome.storage.local.set({ apiKey: api.apiKey }); await chrome.storage.session.remove('apiKey'); }
  delete api.apiKey;
  await chrome.storage.local.set({ ...api, apiKeySessionOnly: fields.apiKeySessionOnly.checked, customInputRate: Math.max(0, Number(fields.customInputRate.value) || 0), customOutputRate: Math.max(0, Number(fields.customOutputRate.value) || 0), persistOverlays: fields.persistOverlays.checked, fontSizeMode: fields.fontSizeMode.value, manualFontSize: clamp(fields.manualFontSize, 8, 36, 14), fontFamily: fields.fontFamily.value, bubbleBgColor: fields.bubbleBgColor.value, textColor: fields.textColor.value });
  status.textContent = 'Settings saved';
}
function updateVisibility() { document.getElementById('manualFontContainer').style.display = fields.fontSizeMode.value === 'manual' ? 'block' : 'none'; }
function renderUsage(history) { if (!history.length) return; const totals = history.reduce((sum, item) => ({ requests: sum.requests + (item.requests || 0), tokens: sum.tokens + (item.promptTokens || 0) + (item.completionTokens || 0), bytes: sum.bytes + (item.imageBytes || 0), cost: sum.cost + (item.estimatedCost || 0) }), { requests: 0, tokens: 0, bytes: 0, cost: 0 }); usageSummary.textContent = `${totals.requests} API requests | ${totals.tokens} tokens | ${(totals.bytes / 1048576).toFixed(1)} MB uploaded | Estimated $${totals.cost.toFixed(4)}`; }
function clamp(input, min, max, fallback) { const parsed = Number.parseInt(input.value, 10); const value = Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback; input.value = value; return value; }
function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(autoSave, 400); }