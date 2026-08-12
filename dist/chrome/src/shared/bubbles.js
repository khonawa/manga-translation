/**
 * Shared bubble normalisation. Previously this existed twice with subtly different
 * rules: normalizeProviderArray in the service worker and normalizeBubble in the
 * content script, which meant a region could survive one check and fail the other.
 */

export const MAX_BUBBLES = 100;
export const MAX_TEXT_LENGTH = 2000;

function clampCoordinate(value) {
  return Math.max(0, Math.min(1000, value));
}

function cleanText(value) {
  return String(value ?? '').trim().slice(0, MAX_TEXT_LENGTH);
}

/**
 * Validates one region. `textKey` is the field that must be present and non-empty
 * ('source' after an OCR-only pass, 'english' once a translation exists).
 */
export function normalizeBubble(bubble, textKey = 'english') {
  if (!bubble || !Array.isArray(bubble.box_2d) || bubble.box_2d.length !== 4) return null;

  const box = bubble.box_2d.map(Number);
  if (!box.every(Number.isFinite)) return null;

  const [ymin, xmin, ymax, xmax] = box.map(clampCoordinate);
  if (ymax <= ymin || xmax <= xmin) return null;

  const text = cleanText(bubble[textKey]);
  if (!text) return null;

  const normalized = {
    box_2d: [ymin, xmin, ymax, xmax],
    source: cleanText(bubble.source)
  };
  normalized[textKey] = text;
  return normalized;
}

export function normalizeBubbles(bubbles, textKey = 'english') {
  if (!Array.isArray(bubbles)) return [];
  return bubbles
    .map(bubble => normalizeBubble(bubble, textKey))
    .filter(Boolean)
    .slice(0, MAX_BUBBLES);
}

/** Fractional overlap of the smaller of two rects, used for de-duping capture regions. */
export function overlapRatio(first, second) {
  if (!first || !second) return 0;
  const width = Math.max(0, Math.min(first.left + first.width, second.left + second.width) - Math.max(first.left, second.left));
  const height = Math.max(0, Math.min(first.top + first.height, second.top + second.height) - Math.max(first.top, second.top));
  const smaller = Math.max(1, Math.min(first.width * first.height, second.width * second.height));
  return (width * height) / smaller;
}

export function rectsSubstantiallyOverlap(first, second, threshold = 0.35) {
  return overlapRatio(first, second) >= threshold;
}
