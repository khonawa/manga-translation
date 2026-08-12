/**
 * Provider-native structured output.
 *
 * Asking a chat model for JSON in prose and then repairing the result is the root cause
 * of the malformed-JSON retry path. OpenAI-compatible endpoints support a strict
 * json_schema response format and Anthropic supports a forced tool call; both make
 * invalid output effectively impossible. Local runtimes get the lenient parser instead.
 */

const BOX_SCHEMA = {
  type: 'array',
  description: 'Bounding box as [ymin, xmin, ymax, xmax], scaled 0-1000.',
  items: { type: 'integer', minimum: 0, maximum: 1000 },
  minItems: 4,
  maxItems: 4
};

export const OCR_SCHEMA = {
  type: 'object',
  properties: {
    regions: {
      type: 'array',
      items: {
        type: 'object',
        properties: { box_2d: BOX_SCHEMA, source: { type: 'string' } },
        required: ['box_2d', 'source'],
        additionalProperties: false
      }
    }
  },
  required: ['regions'],
  additionalProperties: false
};

export const COMBINED_SCHEMA = {
  type: 'object',
  properties: {
    regions: {
      type: 'array',
      items: {
        type: 'object',
        properties: { box_2d: BOX_SCHEMA, source: { type: 'string' }, english: { type: 'string' } },
        required: ['box_2d', 'source', 'english'],
        additionalProperties: false
      }
    }
  },
  required: ['regions'],
  additionalProperties: false
};

export const TRANSLATION_SCHEMA = {
  type: 'object',
  properties: {
    translations: {
      type: 'array',
      items: {
        type: 'object',
        properties: { index: { type: 'integer' }, translation: { type: 'string' } },
        required: ['index', 'translation'],
        additionalProperties: false
      }
    }
  },
  required: ['translations'],
  additionalProperties: false
};

/** Extra request fields that ask an OpenAI-compatible endpoint for strict JSON. */
export function openAiResponseFormat(name, schema) {
  return { response_format: { type: 'json_schema', json_schema: { name, strict: true, schema } } };
}

/** Anthropic equivalent: a single forced tool call whose input matches the schema. */
export function anthropicToolChoice(name, schema) {
  return {
    tools: [{ name, description: 'Return the extracted manga regions.', input_schema: schema }],
    tool_choice: { type: 'tool', name }
  };
}

/**
 * Unwraps the schema's single wrapper property so callers always receive a plain array,
 * regardless of whether structured output or the lenient parser produced it.
 */
export function unwrapRegions(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return null;
  return payload.regions ?? payload.translations ?? null;
}
