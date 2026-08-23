import { PROVIDERS, getProvider } from './src/shared/providers.js';
import { MAX_API_PROFILES, normalizeApiProfiles } from './src/shared/routing.js';
import { sessionGet, sessionSet, sessionRemove } from './src/shared/storage.js';

const fields = {
  sourceLanguage: document.getElementById('sourceLanguage'), targetLanguage: document.getElementById('targetLanguage'), separateStages: document.getElementById('separateStages'), persistOverlays: document.getElementById('persistOverlays'),
  apiKeySessionOnly: document.getElementById('apiKeySessionOnly'), customInputRate: document.getElementById('customInputRate'), customOutputRate: document.getElementById('customOutputRate'),
  fontSizeMode: document.getElementById('fontSizeMode'), manualFontSize: document.getElementById('manualFontSize'), fontFamily: document.getElementById('fontFamily'), bubbleBgColor: document.getElementById('bubbleBgColor'), textColor: document.getElementById('textColor')
};
const status = document.getElementById('status'); const onboarding = document.getElementById('onboarding'); const usageSummary = document.getElementById('usageSummary');
const profilesContainer = document.getElementById('apiProfiles');
const profileSelect = document.getElementById('profileSelect');
let saveTimer; let profiles = []; let selectedProfile = 0; initialize();

function providerOptions(selected) {
  return Object.entries(PROVIDERS).map(([value, preset]) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = preset.label;
    option.selected = value === selected;
    return option;
  });
}

function renderProfiles() {
  profileSelect.replaceChildren(...profiles.map((profile, index) => {
    const option = document.createElement('option');
    option.value = index;
    option.textContent = `${profile.name}${profile.enabled ? '' : ' (disabled)'}`;
    option.selected = index === selectedProfile;
    return option;
  }));
  document.getElementById('removeProfile').disabled = profiles.length <= 1;
  profilesContainer.replaceChildren(...profiles.map((profile, index) => {
    const wrapper = document.createElement('section');
    wrapper.className = 'profile';
    wrapper.dataset.index = index;
    wrapper.hidden = index !== selectedProfile;
    wrapper.innerHTML = `<div class="profile-head"><input type="text" data-field="name" aria-label="API profile name"><div class="profile-actions"><label class="check"><input type="checkbox" data-field="enabled"> Enabled</label><button type="button" class="secondary" data-action="test">Test</button></div></div><label>Provider:</label><select data-field="provider"></select><label>Endpoint URL:</label><input type="text" data-field="apiEndpoint" placeholder="https://api.provider.com/v1/chat/completions"><label>API Key / Token:</label><input type="password" data-field="apiKey" placeholder="Leave empty for local providers" autocomplete="off"><div class="profile-actions"><button type="button" class="secondary" data-action="toggle-key">Show key</button><button type="button" class="secondary" data-action="clear-key">Clear key</button></div><label>Model Name:</label><input type="text" data-field="apiModel">`;
    wrapper.querySelector('[data-field="provider"]').replaceChildren(...providerOptions(profile.provider));
    for (const input of wrapper.querySelectorAll('[data-field]')) {
      const key = input.dataset.field;
      if (input.type === 'checkbox') input.checked = profile[key]; else input.value = profile[key];
    }
    return wrapper;
  }));
}

function newProfile(number) {
  return normalizeApiProfiles([{ id: `profile-${Date.now()}-${number}`, name: `API ${number}`, enabled: false, provider: 'gemini' }])[0];
}

function isConfiguredProfile(profile, index) {
  return index === 0 || profile.enabled || profile.apiEndpoint || profile.apiKey || profile.apiModel;
}

async function initialize() {
  const [stored, session] = await Promise.all([chrome.storage.local.get([...Object.keys(fields), 'provider', 'apiEndpoint', 'apiKey', 'apiModel', 'apiProfiles', 'onboardingComplete', 'usageHistory']), sessionGet(['apiKey', 'apiProfiles'])]);
  const fallback = { provider: stored.provider, apiEndpoint: stored.apiEndpoint, apiKey: session.apiKey || stored.apiKey, apiModel: stored.apiModel };
  profiles = normalizeApiProfiles(session.apiProfiles || stored.apiProfiles, fallback).filter(isConfiguredProfile);
  renderProfiles();
  Object.entries(fields).forEach(([key, input]) => { if (stored[key] === undefined) return; if (input.type === 'checkbox') input.checked = stored[key]; else input.value = stored[key]; });
  onboarding.hidden = stored.onboardingComplete === true; updateVisibility(); renderUsage(stored.usageHistory || []);
}
profileSelect.addEventListener('change', () => { selectedProfile = Number(profileSelect.value); renderProfiles(); });
document.getElementById('addProfile').addEventListener('click', () => {
  if (profiles.length >= MAX_API_PROFILES) { status.textContent = `You can configure up to ${MAX_API_PROFILES} APIs.`; return; }
  profiles.push(newProfile(profiles.length + 1));
  selectedProfile = profiles.length - 1;
  renderProfiles();
  autoSave();
});
document.getElementById('removeProfile').addEventListener('click', () => {
  if (profiles.length <= 1) return;
  profiles.splice(selectedProfile, 1);
  selectedProfile = Math.min(selectedProfile, profiles.length - 1);
  renderProfiles();
  autoSave();
});
function profileFromEvent(event) {
  const wrapper = event.target.closest('.profile');
  return wrapper ? { wrapper, profile: profiles[Number(wrapper.dataset.index)] } : null;
}
profilesContainer.addEventListener('change', event => {
  const context = profileFromEvent(event); if (!context) return;
  const { profile } = context; const key = event.target.dataset.field;
  if (key) profile[key] = event.target.type === 'checkbox' ? event.target.checked : event.target.value;
  if (key === 'provider') {
    const preset = getProvider(profile.provider);
    profile.apiEndpoint = preset.endpoint;
    profile.apiModel = preset.model;
    renderProfiles();
  }
  autoSave();
});
profilesContainer.addEventListener('input', event => {
  const context = profileFromEvent(event); const key = event.target.dataset.field;
  if (!context || !key) return;
  context.profile[key] = event.target.value;
  scheduleSave();
});
profilesContainer.addEventListener('click', async event => {
  const action = event.target.dataset.action; if (!action) return;
  const context = profileFromEvent(event); if (!context) return;
  const { wrapper, profile } = context;
  if (action === 'toggle-key') { const key = wrapper.querySelector('[data-field="apiKey"]'); key.type = key.type === 'password' ? 'text' : 'password'; event.target.textContent = key.type === 'password' ? 'Show key' : 'Hide key'; }
  if (action === 'clear-key') { profile.apiKey = ''; wrapper.querySelector('[data-field="apiKey"]').value = ''; autoSave(); }
  if (action === 'test') await testProfiles([profile], event.target);
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
document.getElementById('testConnection').addEventListener('click', event => testProfiles(profiles.filter(profile => profile.enabled), event.currentTarget));
async function testProfiles(candidates, button) {
  button.disabled = true;
  status.textContent = `Testing ${candidates.length} API profile${candidates.length === 1 ? '' : 's'}...`;
  try {
    await ensureProfilePermissions(candidates);
    await autoSave();
    for (const profile of candidates) {
      const response = await chrome.runtime.sendMessage({ action: 'TEST_CONNECTION', config: profile });
      if (!response?.success) throw new Error(`${profile.name}: ${response?.error || 'Connection failed.'}`);
    }
    await chrome.storage.local.set({ onboardingComplete: true });
    onboarding.hidden = true;
    status.textContent = `Connected: ${candidates.map(profile => profile.name).join(', ')}`;
  } catch (error) {
    status.textContent = `Connection failed: ${error.message}`;
  } finally {
    button.disabled = false;
  }
}
function endpointPermission(endpoint) {
  const url = new URL(endpoint);
  return `${url.protocol}//${url.host}/*`;
}
async function ensureProfilePermissions(candidates) {
  const origins = [...new Set(candidates.filter(profile => profile.enabled !== false).map(profile => endpointPermission(profile.apiEndpoint)))];
  if (!origins.length || await chrome.permissions.contains({ origins })) return;
  const granted = await chrome.permissions.request({ origins });
  if (!granted) throw new Error('Provider access was not granted. Allow access to the configured API endpoint and try again.');
}
async function autoSave() {
  for (const profile of profiles.filter(item => item.enabled)) { try { const url = new URL(profile.apiEndpoint); if (!['http:', 'https:'].includes(url.protocol)) throw new Error(); } catch { status.textContent = `${profile.name}: enter a valid HTTP(S) endpoint`; return; } }
  const first = profiles.find(profile => profile.enabled) || profiles[0];
  if (fields.apiKeySessionOnly.checked) { await sessionSet({ apiProfiles: profiles, apiKey: first.apiKey }); await chrome.storage.local.remove(['apiProfiles', 'apiKey']); }
  else { await chrome.storage.local.set({ apiProfiles: profiles, apiKey: first.apiKey }); await sessionRemove(['apiProfiles', 'apiKey']); }
  await chrome.storage.local.set({ provider: first.provider, apiEndpoint: first.apiEndpoint, apiModel: first.apiModel, sourceLanguage: fields.sourceLanguage.value, targetLanguage: fields.targetLanguage.value, separateStages: fields.separateStages.checked, apiKeySessionOnly: fields.apiKeySessionOnly.checked, customInputRate: Math.max(0, Number(fields.customInputRate.value) || 0), customOutputRate: Math.max(0, Number(fields.customOutputRate.value) || 0), persistOverlays: fields.persistOverlays.checked, fontSizeMode: fields.fontSizeMode.value, manualFontSize: clamp(fields.manualFontSize, 8, 36, 14), fontFamily: fields.fontFamily.value, bubbleBgColor: fields.bubbleBgColor.value, textColor: fields.textColor.value });
  status.textContent = 'Settings saved';
}
function updateVisibility() { document.getElementById('manualFontContainer').style.display = fields.fontSizeMode.value === 'manual' ? 'block' : 'none'; }
function renderUsage(history) { if (!history.length) return; const totals = history.reduce((sum, item) => ({ requests: sum.requests + (item.requests || 0), tokens: sum.tokens + (item.promptTokens || 0) + (item.completionTokens || 0), bytes: sum.bytes + (item.imageBytes || 0), cost: sum.cost + (item.estimatedCost || 0) }), { requests: 0, tokens: 0, bytes: 0, cost: 0 }); usageSummary.textContent = `${totals.requests} API requests | ${totals.tokens} tokens | ${(totals.bytes / 1048576).toFixed(1)} MB uploaded | Estimated $${totals.cost.toFixed(4)}`; }
function clamp(input, min, max, fallback) { const parsed = Number.parseInt(input.value, 10); const value = Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback; input.value = value; return value; }
function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(autoSave, 400); }