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

/**
 * Incremental extractor for streaming responses. As SSE chunks accumulate into a partial
 * JSON document, this returns the region objects that have closed since the last call, so
 * the page can render each translated bubble the moment the model finishes writing it.
 *
 * Regions sit inside a wrapper ({"regions":[...]}), so they never reach depth 0; this
 * scanner captures every balanced object at any depth and keeps the ones shaped like a
 * region. `emittedUpto` tracks the end index of the last object reported so repeats are
 * not emitted as more chunks arrive.
 */
export function createStreamingRegionParser() {
  let text = '';
  let emittedUpto = 0;
  return {
    /** Feed a new chunk; returns the newly completed region objects. */
    push(chunk) {
      text += chunk;
      const fresh = [];
      const stack = [];
      let inString = false;
      let escaped = false;
      for (let index = 0; index < text.length; index += 1) {
        const character = text[index];
        if (inString) {
          if (escaped) escaped = false;
          else if (character === '\\') escaped = true;
          else if (character === '"') inString = false;
          continue;
        }
        if (character === '"') inString = true;
        else if (character === '{') stack.push(index);
        else if (character === '}' && stack.length) {
          const start = stack.pop();
          const end = index + 1;
          // Only the innermost objects can be regions; the wrapper closes last and is
          // filtered out by isCompleteRegion. emittedUpto stops re-reporting on later pushes.
          if (end > emittedUpto) {
            try {
              const parsed = JSON.parse(text.slice(start, end));
              if (isCompleteRegion(parsed)) {
                fresh.push(parsed);
                emittedUpto = end;
              }
            } catch { /* incomplete or non-region object */ }
          }
        }
      }
      return fresh;
    },
    /** Final full parse once the stream ends, for authoritative usage/caching. */
    finish() {
      return parseJsonArray(text);
    }
  };
}

function isCompleteRegion(object) {
  return object && Array.isArray(object.box_2d) && object.box_2d.length === 4
    && typeof object.source === 'string';
}
