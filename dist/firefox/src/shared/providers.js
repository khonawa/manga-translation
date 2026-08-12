/**
 * Single source of truth for provider presets and capabilities.
 * Previously duplicated between background.js and options.js, where the two copies
 * had already drifted in formatting.
 */

export const PROVIDERS = {
  openai: {
    label: 'OpenAI',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    model: 'gpt-4o-mini',
    // Input/output USD per million tokens, used for the usage estimate only.
    rates: [0.15, 0.60],
    ratesAsOf: '2024-07-18',
    structuredOutput: 'json_schema'
  },
  gemini: {
    label: 'Gemini (OpenAI-compatible)',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    model: 'gemini-2.0-flash',
    rates: [0.10, 0.40],
    ratesAsOf: '2025-02-05',
    structuredOutput: 'json_schema'
  },
  anthropic: {
    label: 'Anthropic',
    endpoint: 'https://api.anthropic.com/v1/messages',
    model: 'claude-sonnet-4-5',
    rates: [3, 15],
    ratesAsOf: '2025-09-29',
    structuredOutput: 'tool'
  },
  ollama: {
    label: 'Ollama (local)',
    endpoint: 'http://localhost:11434/v1/chat/completions',
    model: 'llava',
    rates: [0, 0],
    ratesAsOf: null,
    structuredOutput: 'none'
  },
  lmstudio: {
    label: 'LM Studio (local)',
    endpoint: 'http://localhost:1234/v1/chat/completions',
    model: 'local-model',
    rates: [0, 0],
    ratesAsOf: null,
    structuredOutput: 'none'
  },
  custom: {
    label: 'Custom OpenAI-compatible',
    endpoint: '',
    model: '',
    rates: [0, 0],
    ratesAsOf: null,
    structuredOutput: 'none'
  }
};

export const DEFAULT_PROVIDER = 'openai';

export function getProvider(name) {
  return PROVIDERS[name] || PROVIDERS.custom;
}

export function providerRates(name, customRates) {
  if (name === 'custom' && Array.isArray(customRates) && customRates.length === 2) {
    return customRates.map(rate => Math.max(0, Number(rate) || 0));
  }
  return getProvider(name).rates;
}
