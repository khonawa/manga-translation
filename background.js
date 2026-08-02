import { getProvider, providerRates, DEFAULT_PROVIDER } from './src/shared/providers.js';
import { OCR_SCHEMA, COMBINED_SCHEMA, TRANSLATION_SCHEMA, openAiResponseFormat, anthropicToolChoice } from './src/shared/schema.js';
import { normalizeBubbles } from './src/shared/bubbles.js';
import { parseJsonArray, normalizeTranslationArray } from './src/shared/parse.js';
import { normalizeApiProfiles, orderedEnabledProfiles } from './src/shared/routing.js';

const activeRequests = new Map();
const CACHE_PREFIX = 'translationCache:';
const CACHE_TTL = 30 * 24 * 60 * 60 * 1000;
const CACHE_SCHEMA_VERSION = 2;
const PAGE_SESSION_TTL = 90 * 24 * 60 * 60 * 1000;
const MANAGED_STORAGE_LIMIT = 20 * 1024 * 1024;
const REQUEST_TIMEOUT = 90_000;
const MAX_RETRY_ATTEMPTS = 4;
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const CLEANUP_ALARM = 'storageCleanup';
const CLEANUP_INTERVAL_MINUTES = 360;
const MAX_CAPTURE_DIMENSION = 1800;
const CAPTURE_JPEG_QUALITY = 0.92;
let usageWriteQueue = Promise.resolve();

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  chrome.alarms.create(CLEANUP_ALARM, { periodInMinutes: CLEANUP_INTERVAL_MINUTES });
  await cleanupStoredData();
  if (reason === 'install') {
    await chrome.storage.local.set({ onboardingComplete: false });
    chrome.runtime.openOptionsPage();
  }
});

// onInstalled alone leaves storage un-swept between updates, which is how the 10MB
// local quota fills up during normal reading.
chrome.runtime.onStartup.addListener(async () => {
  chrome.alarms.create(CLEANUP_ALARM, { periodInMinutes: CLEANUP_INTERVAL_MINUTES });
  await cleanupStoredData();
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === CLEANUP_ALARM) cleanupStoredData();
});

chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const actions = {
    'start-snip': 'START_SNIP',
    'full-page-ocr': 'START_FULL_PAGE',
    'save-region-screenshot': 'SAVE_REGION_SCREENSHOT',
    'save-page-screenshot': 'SAVE_PAGE_SCREENSHOT',
    'clear-overlays': 'CLEAR_OVERLAYS'
  };
  if (!tab?.id || !actions[command]) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { action: actions[command] });
  } catch (error) {
    console.warn('Manga Translator is unavailable on this page:', error.message);
  }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'CAPTURE_TAB') {
    captureRequestingTab(sender.tab)
      .then(dataUrl => sendResponse({ dataUrl }))
      .catch(error => sendResponse({ error: cleanError(error) }));
    return true;
  }

  if (request.action === 'CAPTURE_REGION') {
    captureRegion(sender.tab, request.rect, request.viewport)
      .then(dataUrl => sendResponse({ dataUrl }))
      .catch(error => sendResponse({ error: cleanError(error) }));
    return true;
  }

  if (request.action === 'DOWNLOAD_IMAGE') {
    startDownload(request.dataUrl, request.filename)
      .then(downloadId => sendResponse({ success: true, downloadId }))
      .catch(error => sendResponse({ success: false, error: cleanError(error) }));
    return true;
  }

  if (request.action === 'TRANSLATE_IMAGE') {
    runTranslationPipeline(request.base64Image, request.requestId, request.bypassCache, sender.tab?.id)
      .then(data => sendResponse({ success: true, data }))
      .catch(error => sendResponse({ success: false, error: cleanError(error) }));
    return true;
  }

  if (request.action === 'RETRY_BUBBLE') {
    retryBubbleTranslation(request.source, request.requestId, sender.tab?.id)
      .then(data => sendResponse({ success: true, data }))
      .catch(error => sendResponse({ success: false, error: cleanError(error) }));
    return true;
  }

  if (request.action === 'CANCEL_TRANSLATION') {
    const entry = activeRequests.get(request.requestId);
    // Only the tab that started a request may cancel it.
    if (entry && (entry.tabId === undefined || entry.tabId === sender.tab?.id)) {
      entry.controller.abort();
      sendResponse({ success: true });
    } else {
      sendResponse({ success: false, error: 'No matching translation to cancel.' });
    }
    return false;
  }

  if (request.action === 'TEST_CONNECTION') {
    testConnection(request.config)
      .then(data => sendResponse({ success: true, data }))
      .catch(error => sendResponse({ success: false, error: cleanError(error) }));
    return true;
  }
});

/**
 * Validates a download before handing it to chrome.downloads, so a compromised or
 * spoofed message cannot write outside the download directory or fetch a remote URL.
 */
async function startDownload(dataUrl, filename) {
  if (typeof dataUrl !== 'string' || !/^data:image\/(png|jpeg|jpg|webp);base64,/i.test(dataUrl)) {
    throw new Error('Only base64 image data URLs can be downloaded.');
  }
  const safeName = String(filename || '')
    .replace(/[\\/]+/g, '-')     // no path separators
    .replace(/\.{2,}/g, '.')     // no directory traversal
    .replace(/[^\w.\-]/g, '-')
    .slice(0, 120);
  if (!/\.(png|jpe?g|webp)$/i.test(safeName)) throw new Error('Screenshot filename must end in an image extension.');
  return chrome.downloads.download({ url: dataUrl, filename: safeName, saveAs: false });
}

async function captureRequestingTab(senderTab, format = 'jpeg') {
  if (!senderTab?.id || senderTab.windowId === undefined) throw new Error('The requesting tab is unavailable.');
  const [activeTab] = await chrome.tabs.query({ active: true, windowId: senderTab.windowId });
  if (activeTab?.id !== senderTab.id) throw new Error('The requesting tab is no longer active. Return to it and try again.');
  return format === 'png'
    ? chrome.tabs.captureVisibleTab(senderTab.windowId, { format: 'png' })
    : chrome.tabs.captureVisibleTab(senderTab.windowId, { format: 'jpeg', quality: 90 });
}

/**
 * Crops here in the worker instead of in the page. The old path captured JPEG, decoded it in
 * the content script, re-encoded the crop as JPEG, and shipped a multi-megabyte data URL back
 * over messaging. Capturing PNG and encoding JPEG once removes a full generation of lossy
 * artifacts from the pixels the OCR model has to read, and the big buffer never crosses a
 * process boundary twice.
 */
async function captureRegion(senderTab, rect, viewport) {
  if (!rect || ![rect.left, rect.top, rect.width, rect.height].every(Number.isFinite)) {
    throw new Error('The capture region is invalid.');
  }
  if (rect.width < 1 || rect.height < 1) throw new Error('The capture region is too small to translate.');

  const dataUrl = await captureRequestingTab(senderTab, 'png');
  const bitmap = await createImageBitmap(dataUrlToBlob(dataUrl));
  try {
    // captureVisibleTab returns device pixels; the rect arrives in CSS pixels.
    const scaleX = bitmap.width / Math.max(1, viewport?.width || bitmap.width);
    const scaleY = bitmap.height / Math.max(1, viewport?.height || bitmap.height);
    const sourceLeft = Math.max(0, Math.min(bitmap.width, rect.left * scaleX));
    const sourceTop = Math.max(0, Math.min(bitmap.height, rect.top * scaleY));
    const sourceWidth = Math.max(1, Math.min(bitmap.width - sourceLeft, rect.width * scaleX));
    const sourceHeight = Math.max(1, Math.min(bitmap.height - sourceTop, rect.height * scaleY));

    const outputScale = Math.min(1, MAX_CAPTURE_DIMENSION / Math.max(sourceWidth, sourceHeight));
    const canvas = new OffscreenCanvas(
      Math.max(1, Math.round(sourceWidth * outputScale)),
      Math.max(1, Math.round(sourceHeight * outputScale))
    );
    const context = canvas.getContext('2d');
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, sourceLeft, sourceTop, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height);

    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: CAPTURE_JPEG_QUALITY });
    return blobToDataUrl(blob);
  } finally {
    bitmap.close();
  }
}

// Converted by hand rather than with fetch()/FileReader: neither is dependably available to a
// service worker for data URLs, and atob/btoa are.
function dataUrlToBlob(dataUrl) {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl || '');
  if (!match) throw new Error('The tab capture returned unexpected image data.');
  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: match[1] });
}

async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  // Chunked to stay clear of the argument limit on String.fromCharCode for multi-MB captures.
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return `data:${blob.type};base64,${btoa(binary)}`;
}

async function runTranslationPipeline(base64Image, requestId, bypassCache = false, tabId, allowMalformedRetry = true, controller = new AbortController()) {
  validateImage(base64Image);
  activeRequests.set(requestId, { controller, tabId });
  const config = await getApiConfig();
  const cacheKey = CACHE_PREFIX + await hashText(base64Image + JSON.stringify({
    schema: CACHE_SCHEMA_VERSION,
    profiles: config.apiProfiles.filter(profile => profile.enabled).map(profile => ({
      provider: profile.provider,
      endpoint: profile.apiEndpoint,
      model: profile.apiModel
    })),
    sourceLanguage: config.sourceLanguage || 'Automatic',
    targetLanguage: config.targetLanguage,
    separateStages: config.separateStages
  }));

  if (!bypassCache) {
    const cached = (await chrome.storage.local.get(cacheKey))[cacheKey];
    if (cached && Date.now() - cached.createdAt < CACHE_TTL) {
      return { ...cached.result, cached: true };
    }
    if (cached) await chrome.storage.local.remove(cacheKey);
  }

  try {
    notifyProgress(tabId, requestId, 'ocr', 'Finding text regions...');
    let bubbles;
    let usage = { promptTokens: 0, completionTokens: 0, requests: 0 };

    if (config.separateStages) {
      const ocrResult = await callVisionProvider(base64Image, config, controller.signal, buildOcrPrompt(config), { name: 'manga_ocr', schema: OCR_SCHEMA });
      const ocrBubbles = normalizeBubbles(parseJsonArray(ocrResult.content), 'source');
      usage = mergeUsage(usage, ocrResult.usage);
      if (!ocrBubbles.length) {
        notifyProgress(tabId, requestId, 'translate', 'Retrying with combined vision translation...');
        const fallbackResult = await callVisionProvider(base64Image, config, controller.signal, buildCombinedPrompt(config), { name: 'manga_translation', schema: COMBINED_SCHEMA });
        usage = mergeUsage(usage, fallbackResult.usage);
        bubbles = normalizeBubbles(parseJsonArray(fallbackResult.content), 'english');
      } else {
        notifyProgress(tabId, requestId, 'translate', `Translating ${ocrBubbles.length} regions...`);
        const translationResult = await callTextProvider(
          JSON.stringify(ocrBubbles.map(({ source }, index) => ({ index, source }))),
          config,
          controller.signal,
          buildTranslationPrompt(config),
          { name: 'manga_translations', schema: TRANSLATION_SCHEMA }
        );
        usage = mergeUsage(usage, translationResult.usage);
        const translations = normalizeTranslationArray(translationResult.content);
        bubbles = ocrBubbles.map((bubble, index) => ({
          ...bubble,
          english: translations.get(index) || bubble.source
        }));
      }
    } else {
      const result = await callVisionProvider(base64Image, config, controller.signal, buildCombinedPrompt(config), { name: 'manga_translation', schema: COMBINED_SCHEMA });
      usage = mergeUsage(usage, result.usage);
      bubbles = normalizeBubbles(parseJsonArray(result.content), 'english');
    }

    const output = { bubbles, usage, cached: false };
    // A full storage quota must never turn a successful (paid) API call into a failure.
    try {
      await chrome.storage.local.set({ [cacheKey]: { createdAt: Date.now(), result: output } });
    } catch (error) {
      console.warn('Could not cache translation result:', error.message);
    }
    try {
      await recordUsage(usage, base64Image.length, config.provider, config.apiModel);
    } catch (error) {
      console.warn('Could not record usage:', error.message);
    }
    notifyProgress(tabId, requestId, 'done', `Ready: ${bubbles.length} translations`);
    return output;
  } catch (error) {
    if (allowMalformedRetry && String(error?.message || '').includes('malformed JSON')) {
      notifyProgress(tabId, requestId, 'retry', 'Provider response was malformed. Retrying once...');
      return runTranslationPipeline(base64Image, requestId, true, tabId, false, controller);
    }
    throw error;
  } finally {
    if (activeRequests.get(requestId)?.controller === controller) activeRequests.delete(requestId);
  }
}

async function cleanupStoredData() {
  const stored = await chrome.storage.local.get(null);
  const now = Date.now();
  const keysToRemove = Object.entries(stored)
    .filter(([key, value]) => {
      if (key.startsWith(CACHE_PREFIX)) return !value?.createdAt || now - value.createdAt >= CACHE_TTL;
      if (key.startsWith('pageSession:')) {
        // Sessions used to be keyed by full URL. Those keys are unreachable now that keys are
        // hashed, and they leak browsing history, so drop them on sight.
        if (key.includes('://')) return true;
        return !value?.createdAt || now - value.createdAt >= PAGE_SESSION_TTL || value?.config?.apiKey;
      }
      return false;
    })
    .map(([key]) => key);
  if (keysToRemove.length) await chrome.storage.local.remove(keysToRemove);
  const retained = Object.entries(stored)
    .filter(([key]) => (key.startsWith(CACHE_PREFIX) || key.startsWith('pageSession:')) && !keysToRemove.includes(key))
    .map(([key, value]) => ({ key, value, bytes: new Blob([JSON.stringify(value)]).size }))
    .sort((first, second) => (second.value?.createdAt || 0) - (first.value?.createdAt || 0));
  let retainedBytes = retained.reduce((sum, entry) => sum + entry.bytes, 0);
  const overLimit = [];
  while (retainedBytes > MANAGED_STORAGE_LIMIT && retained.length) {
    const oldest = retained.pop();
    retainedBytes -= oldest.bytes;
    overLimit.push(oldest.key);
  }
  if (overLimit.length) await chrome.storage.local.remove(overLimit);
}

async function retryBubbleTranslation(source, requestId, tabId) {
  const cleanSource = String(source || '').trim();
  if (!cleanSource) throw new Error('Original OCR text is unavailable for this bubble.');
  const config = await getApiConfig();
  const controller = new AbortController();
  activeRequests.set(requestId, { controller, tabId });
  try {
    const result = await callTextProvider(
      JSON.stringify([{ index: 0, source: cleanSource }]),
      config,
      controller.signal,
      buildTranslationPrompt(config)
    );
    const translation = normalizeTranslationArray(result.content).get(0);
    if (!translation) throw new Error('The provider returned no translation.');
    try {
      await recordUsage(result.usage, 0, config.provider, config.apiModel);
    } catch (error) {
      console.warn('Could not record usage:', error.message);
    }
    return { translation };
  } finally {
    activeRequests.delete(requestId);
  }
}

async function getApiConfig(override = {}) {
  const [stored, session] = await Promise.all([chrome.storage.local.get([
    'provider', 'apiEndpoint', 'apiKey', 'apiModel', 'apiProfiles', 'apiProfileCursor', 'sourceLanguage', 'targetLanguage', 'separateStages', 'customInputRate', 'customOutputRate'
  ]), chrome.storage.session.get(['apiKey', 'apiProfiles'])]);
  const config = { ...stored, apiKey: session.apiKey || stored.apiKey, ...override };
  config.provider ||= DEFAULT_PROVIDER;
  config.targetLanguage ||= 'English';
  config.separateStages = config.separateStages !== false;

  const preset = getProvider(config.provider);
  config.apiEndpoint = config.apiEndpoint?.trim() || preset.endpoint;
  config.apiModel = config.apiModel?.trim() || preset.model;

  const suppliedProfile = override.apiEndpoint || override.apiModel || override.apiKey;
  config.apiProfiles = normalizeApiProfiles(
    suppliedProfile ? [{ ...override, enabled: true }] : (session.apiProfiles || stored.apiProfiles),
    config
  );
  if (!config.apiProfiles.some(profile => profile.enabled)) {
    throw new Error('No API profiles are enabled. Open the extension settings and enable at least one.');
  }
  config.apiProfileCursor = Number(stored.apiProfileCursor) || 0;

  if (!config.apiEndpoint) throw new Error('No API endpoint is configured. Open the extension settings and enter one.');
  if (!config.apiModel) throw new Error('No model name is configured. Open the extension settings and enter one.');

  let endpoint;
  try {
    endpoint = new URL(config.apiEndpoint);
  } catch {
    throw new Error(`"${config.apiEndpoint}" is not a valid URL. Check the API endpoint in settings.`);
  }
  if (!['http:', 'https:'].includes(endpoint.protocol)) throw new Error('API endpoint must use HTTP or HTTPS.');
  config.apiEndpoint = endpoint.href;
  return config;
}

async function callVisionProvider(image, config, signal, prompt, structured) {
  return callChatCompletions(config, signal, [
    { role: 'system', content: 'You are a manga OCR and translation assistant. Return only the requested JSON.' },
    { role: 'user', content: [
      { type: 'text', text: prompt },
      { type: 'image_url', image_url: { url: image } }
    ] }
  ], structured);
}

async function callTextProvider(text, config, signal, prompt, structured) {
  return callChatCompletions(config, signal, [
    { role: 'system', content: prompt },
    { role: 'user', content: text }
  ], structured);
}

/**
 * Estimates an output token budget from the prompt size. A dense double-page spread can
 * easily exceed a fixed 2048, and truncation is what forces the malformed-JSON path.
 */
function resolveMaxTokens(messages) {
  const characters = JSON.stringify(messages).length;
  const hasImage = JSON.stringify(messages).includes('"image_url"') || JSON.stringify(messages).includes('"type":"image"');
  const estimate = hasImage ? 4096 : Math.ceil(characters / 2) + 1024;
  return Math.max(2048, Math.min(8192, estimate));
}

function retryDelay(attempt, response) {
  const header = response?.headers.get('retry-after');
  if (header) {
    const seconds = Number(header);
    const milliseconds = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
    if (Number.isFinite(milliseconds) && milliseconds > 0) return Math.min(milliseconds, 30_000);
  }
  const backoff = Math.min(1000 * 2 ** attempt, 16_000);
  return backoff + Math.random() * 400; // jitter avoids synchronised retries
}

const wait = (milliseconds, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, milliseconds);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
});

/**
 * POSTs with a hard timeout plus exponential backoff on transient failures.
 * The caller's abort signal always wins so cancellation stays instant.
 */
async function requestWithRetry(url, init, signal) {
  let lastError;
  for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt += 1) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT);
    const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    try {
      const response = await fetch(url, { ...init, signal: combined });
      if (response.ok) return response;
      if (!RETRYABLE_STATUS.has(response.status) || attempt === MAX_RETRY_ATTEMPTS - 1) {
        throw new Error(await readProviderError(response));
      }
      await wait(retryDelay(attempt, response), signal);
    } catch (error) {
      // A user cancellation must never be retried; a timeout may be.
      if (error.name === 'AbortError' && signal?.aborted) throw error;
      if (error.message?.startsWith('API request failed')) throw error;
      lastError = error.name === 'TimeoutError' || error.name === 'AbortError'
        ? new Error(`The provider did not respond within ${REQUEST_TIMEOUT / 1000}s.`)
        : error;
      if (attempt === MAX_RETRY_ATTEMPTS - 1) throw lastError;
      await wait(retryDelay(attempt), signal);
    }
  }
  throw lastError ?? new Error('The request failed after several attempts.');
}

async function callChatCompletions(config, signal, messages, structured) {
  const profiles = orderedEnabledProfiles(config.apiProfiles, config.apiProfileCursor);
  let lastError;
  for (const profile of profiles) {
    const routedConfig = { ...config, ...profile };
    try {
      const result = await callSingleProvider(routedConfig, signal, messages, structured);
      const enabledProfiles = config.apiProfiles.filter(candidate => candidate.enabled);
      const usedIndex = enabledProfiles.findIndex(candidate => candidate.id === profile.id);
      const nextCursor = (usedIndex + 1) % enabledProfiles.length;
      config.apiProfileCursor = nextCursor;
      await chrome.storage.local.set({ apiProfileCursor: nextCursor });
      return result;
    } catch (error) {
      if (signal?.aborted) throw error;
      lastError = error;
      console.warn(`API profile "${profile.name}" failed; trying the next enabled profile.`, error.message);
    }
  }
  throw new Error(`All enabled API profiles failed. Last error: ${lastError?.message || 'Unknown provider error'}`);
}

async function callSingleProvider(config, signal, messages, structured) {
  if (config.provider === 'anthropic') return callAnthropic(config, signal, messages, structured);
  const headers = { 'Content-Type': 'application/json' };
  if (config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`;
    if (isGoogleAiStudioEndpoint(config.apiEndpoint)) headers['x-goog-api-key'] = config.apiKey;
  }

  // Only ask for strict JSON where the provider actually supports it; local runtimes
  // reject the field, so they keep using the lenient parser.
  const supportsSchema = getProvider(config.provider).structuredOutput === 'json_schema';
  const extra = structured && supportsSchema ? openAiResponseFormat(structured.name, structured.schema) : {};

  const response = await requestWithRetry(config.apiEndpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: config.apiModel, messages, max_tokens: resolveMaxTokens(messages), temperature: 0.2, ...extra })
  }, signal);
  const data = await response.json();
  return {
    content: data.choices?.[0]?.message?.content ?? data,
    usage: {
      promptTokens: data.usage?.prompt_tokens || 0,
      completionTokens: data.usage?.completion_tokens || 0,
      requests: 1
    }
  };
}

function isGoogleAiStudioEndpoint(endpoint) {
  try {
    return new URL(endpoint).hostname === 'generativelanguage.googleapis.com';
  } catch {
    return false;
  }
}

async function callAnthropic(config, signal, messages, structured) {
  const system = messages.find(message => message.role === 'system')?.content || '';
  const userContent = messages.find(message => message.role === 'user')?.content;
  const blocks = Array.isArray(userContent)
    ? userContent.map(part => {
        if (part.type !== 'image_url') return { type: 'text', text: String(part.text || '') };
        const match = part.image_url.url.match(/^data:(image\/[^;]+);base64,(.+)$/);
        if (!match) throw new Error('Anthropic requires a base64 image data URL.');
        return { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } };
      })
    : [{ type: 'text', text: String(userContent || '') }];
  // Anthropic's equivalent of a JSON schema is a forced tool call.
  const extra = structured ? anthropicToolChoice(structured.name, structured.schema) : {};

  const response = await requestWithRetry(config.apiEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': config.apiKey || '', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: config.apiModel, system, messages: [{ role: 'user', content: blocks }], max_tokens: resolveMaxTokens(messages), temperature: 0.2, ...extra })
  }, signal);
  const data = await response.json();

  // A forced tool call returns parsed input; fall back to text for unstructured calls.
  const toolUse = data.content?.find(part => part.type === 'tool_use');
  const content = toolUse ? toolUse.input : (data.content?.find(part => part.type === 'text')?.text || '');

  return {
    content,
    usage: { promptTokens: data.usage?.input_tokens || 0, completionTokens: data.usage?.output_tokens || 0, requests: 1 }
  };
}

function buildOcrPrompt(config) {
  return `Locate every text region in this manga image and transcribe its original text verbatim. Return an object with a "regions" array; each entry has "box_2d" as [ymin, xmin, ymax, xmax] scaled 0-1000 and "source" with the original text. Source language is ${config.sourceLanguage || 'automatic'}. Read right-to-left, top-to-bottom.`;
}

function buildTranslationPrompt(config) {
  return `Translate each indexed manga text naturally into ${config.targetLanguage}. Preserve names, honorifics, and tone. Return an object with a "translations" array; each entry has the matching "index" and its "translation".`;
}

function buildCombinedPrompt(config) {
  return `You are a specialized manga OCR and translation engine. Locate every text bubble, transcribe it, and translate it into ${config.targetLanguage}. Return an object with a "regions" array; each entry has "box_2d" as [ymin, xmin, ymax, xmax] scaled 0-1000, "source" with the original text, and "english" with the translation. Read right-to-left, top-to-bottom.`;
}

async function testConnection(override) {
  const config = await getApiConfig(override);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const result = await callTextProvider('Reply with exactly: OK', config, controller.signal, 'This is a connection test.');
    return { provider: config.provider, model: config.apiModel, response: String(result.content).slice(0, 80) };
  } finally {
    clearTimeout(timeout);
  }
}

async function recordUsage(usage, imageBytes, provider, model) {
  const write = usageWriteQueue.then(async () => {
    const { usageHistory = [] } = await chrome.storage.local.get('usageHistory');
    const storedRates = await chrome.storage.local.get(['customInputRate', 'customOutputRate']);
    const [inputRate, outputRate] = providerRates(provider, [storedRates.customInputRate, storedRates.customOutputRate]);
    const estimatedCost = ((usage.promptTokens * inputRate) + (usage.completionTokens * outputRate)) / 1_000_000;
    usageHistory.push({ ...usage, imageBytes, provider, model, estimatedCost, createdAt: Date.now() });
    await chrome.storage.local.set({ usageHistory: usageHistory.slice(-500) });
  });
  usageWriteQueue = write.catch(() => {});
  return write;
}

function notifyProgress(tabId, requestId, stage, message) {
  if (!tabId) return;
  chrome.tabs.sendMessage(tabId, { action: 'TRANSLATION_PROGRESS', requestId, stage, message }).catch(() => {});
}

function mergeUsage(total, next = {}) {
  return {
    promptTokens: total.promptTokens + (next.promptTokens || 0),
    completionTokens: total.completionTokens + (next.completionTokens || 0),
    requests: total.requests + (next.requests || 0)
  };
}

async function hashText(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}

function validateImage(image) {
  if (typeof image !== 'string' || !image.startsWith('data:image/')) throw new Error('Invalid image data.');
  if (image.length > 12_000_000) throw new Error('Image is too large. Reduce the capture size or quality.');
}

async function readProviderError(response) {
  const text = await response.text();
  try {
    const data = JSON.parse(text);
    return `API request failed (${response.status}): ${String(data.error?.message || data.message || text).slice(0, 300)}`;
  } catch {
    return `API request failed (${response.status}): ${text.slice(0, 300)}`;
  }
}

function cleanError(error) {
  if (error?.name === 'AbortError') return 'Translation cancelled.';
  return String(error?.message || error).slice(0, 300);
}
