// Hashing helper shared by the content script's page-session keys. It is pure and DOM-free
// so it can be unit-tested directly (see test/hash.test.js).

// Session keys used to embed the full URL, which left a readable 90-day browsing history
// sitting in extension storage. Hashing keeps sessions addressable without recording where
// the user has been. Two mixed 32-bit hashes plus the length make collisions unrealistic at
// the couple-hundred-session scale this stores.
export function hashString(value) {
  let first = 0x811c9dc5;
  let second = 0x9e3779b1;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 16777619);
    second = Math.imul(second + code, 2654435761) ^ (second >>> 15);
  }
  return `${(first >>> 0).toString(36)}${(second >>> 0).toString(36)}${value.length.toString(36)}`;
}
