/**
 * Lenient JSON recovery for providers without structured-output support
 * (Ollama, LM Studio, arbitrary custom endpoints).
 */

/**
 * Scans for balanced top-level objects and parses each independently, so one
 * truncated or malformed entry does not discard the whole response.
 */
export function extractValidJsonObjects(json) {
  const objects = [];
  let depth = 0;
  let objectStart = -1;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < json.length; index += 1) {
    const character = json[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{') {
      if (depth === 0) objectStart = index;
      depth += 1;
    } else if (character === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && objectStart >= 0) {
        try { objects.push(JSON.parse(json.slice(objectStart, index + 1))); } catch { /* skip partial object */ }
        objectStart = -1;
      }
    }
  }
  return objects;
}

/** Strips markdown fences and surrounding prose. */
function stripWrapping(content) {
  return String(content ?? '').replace(/```(?:json)?|```/gi, '').trim();
}

/**
 * Parses an array from a model response. Accepts a bare array, an array embedded in
 * prose, or an object wrapper whose single property holds the array.
 */
export function parseJsonArray(content) {
  if (Array.isArray(content)) return content;

  if (content && typeof content === 'object') {
    const nested = content.regions ?? content.translations;
    if (Array.isArray(nested)) return nested;
  }

  const text = stripWrapping(content);

  // Prefer a wrapper object when it encloses the array, e.g. {"regions":[...]}.
  const objectStart = text.indexOf('{');
  const arrayStart = text.indexOf('[');
  if (objectStart >= 0 && (arrayStart < 0 || objectStart < arrayStart)) {
    const objectEnd = text.lastIndexOf('}');
    if (objectEnd > objectStart) {
      try {
        const parsed = JSON.parse(text.slice(objectStart, objectEnd + 1));
        const nested = parsed.regions ?? parsed.translations;
        if (Array.isArray(nested)) return nested;
      } catch { /* fall through to array handling */ }
    }
  }

  if (arrayStart < 0) throw new Error('Provider returned invalid structured output.');
  const arrayEnd = text.lastIndexOf(']');
  const json = arrayEnd > arrayStart ? text.slice(arrayStart, arrayEnd + 1) : text.slice(arrayStart);

  try {
    return JSON.parse(json);
  } catch (error) {
    const recovered = extractValidJsonObjects(json);
    if (recovered.length) return recovered;
    throw new Error(`Provider returned malformed JSON: ${error.message}`);
  }
}

export function normalizeTranslationArray(content) {
  return new Map(
    parseJsonArray(content).map(item => [Number(item.index), String(item.translation ?? '').trim()])
  );
}
