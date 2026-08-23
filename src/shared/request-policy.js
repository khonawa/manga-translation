export function resolveMaxTokens(messages) {
  let hasImage = false;
  let textCharacters = 0;
  for (const message of messages) {
    const content = message?.content;
    if (typeof content === 'string') {
      textCharacters += content.length;
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part?.type === 'image_url' || part?.type === 'image') hasImage = true;
      else if (typeof part?.text === 'string') textCharacters += part.text.length;
    }
  }
  const estimate = hasImage ? 4096 : Math.ceil(textCharacters / 2) + 1024;
  return Math.max(2048, Math.min(8192, estimate));
}

export function retryDelay(attempt, response, now = Date.now(), jitter = Math.random() * 400) {
  const header = response?.headers.get('retry-after');
  if (header) {
    const seconds = Number(header);
    const milliseconds = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now;
    if (Number.isFinite(milliseconds) && milliseconds > 0) return Math.min(milliseconds, 30_000);
  }
  return Math.min(1000 * 2 ** attempt, 16_000) + jitter;
}