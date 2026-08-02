import test from 'node:test';
import assert from 'node:assert/strict';

import { PROVIDERS, getProvider, providerRates, DEFAULT_PROVIDER } from '../src/shared/providers.js';
import { OCR_SCHEMA, COMBINED_SCHEMA, TRANSLATION_SCHEMA, openAiResponseFormat, anthropicToolChoice } from '../src/shared/schema.js';

test('the default provider exists in the table', () => {
  assert.ok(PROVIDERS[DEFAULT_PROVIDER]);
});

test('every provider declares the fields the settings page and worker read', () => {
  for (const [name, preset] of Object.entries(PROVIDERS)) {
    assert.equal(typeof preset.label, 'string', `${name} label`);
    assert.equal(typeof preset.endpoint, 'string', `${name} endpoint`);
    assert.equal(typeof preset.model, 'string', `${name} model`);
    assert.ok(Array.isArray(preset.rates) && preset.rates.length === 2, `${name} rates`);
    assert.ok(['json_schema', 'tool', 'none'].includes(preset.structuredOutput), `${name} structuredOutput`);
  }
});

test('an unknown provider falls back to the custom preset instead of throwing', () => {
  assert.deepEqual(getProvider('not-a-provider'), PROVIDERS.custom);
  assert.deepEqual(getProvider(undefined), PROVIDERS.custom);
});

test('local providers are billed at zero', () => {
  assert.deepEqual(providerRates('ollama'), [0, 0]);
  assert.deepEqual(providerRates('lmstudio'), [0, 0]);
});

test('an unknown provider costs nothing rather than reporting a bogus estimate', () => {
  assert.deepEqual(providerRates('not-a-provider'), [0, 0]);
});

test('custom provider rates are normalized from user settings', () => {
  assert.deepEqual(providerRates('custom', ['1.25', -3]), [1.25, 0]);
  assert.deepEqual(providerRates('openai', [99, 99]), PROVIDERS.openai.rates);
});

test('hosted provider pricing declares when it was last verified', () => {
  for (const name of ['openai', 'gemini', 'anthropic']) assert.match(PROVIDERS[name].ratesAsOf, /^\d{4}-\d{2}-\d{2}$/);
});

test('hosted providers have a non-zero output rate', () => {
  for (const name of ['openai', 'gemini', 'anthropic']) {
    assert.ok(providerRates(name)[1] > 0, name);
  }
});

test('the OCR schema requires a box and the source text', () => {
  const region = OCR_SCHEMA.properties.regions.items;
  assert.deepEqual(region.required, ['box_2d', 'source']);
});

test('the combined schema also requires the translation', () => {
  const region = COMBINED_SCHEMA.properties.regions.items;
  assert.ok(region.required.includes('english'));
});

test('the translation schema pairs an index with a translation', () => {
  const item = TRANSLATION_SCHEMA.properties.translations.items;
  assert.deepEqual(item.required, ['index', 'translation']);
});

test('the OpenAI wrapper produces a strict json_schema response format', () => {
  const format = openAiResponseFormat('manga_ocr', OCR_SCHEMA);
  assert.equal(format.response_format.type, 'json_schema');
  assert.equal(format.response_format.json_schema.name, 'manga_ocr');
  assert.equal(format.response_format.json_schema.strict, true);
  assert.equal(format.response_format.json_schema.schema, OCR_SCHEMA);
});

test('the Anthropic wrapper forces the tool it defines', () => {
  const body = anthropicToolChoice('manga_ocr', OCR_SCHEMA);
  assert.equal(body.tools.length, 1);
  assert.equal(body.tools[0].name, 'manga_ocr');
  assert.equal(body.tools[0].input_schema, OCR_SCHEMA);
  // Anything other than a forced tool choice lets the model reply with prose instead.
  assert.deepEqual(body.tool_choice, { type: 'tool', name: 'manga_ocr' });
});
