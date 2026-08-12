/**
 * Thin wrappers around chrome.storage.session that degrade gracefully on
 * Firefox < 112 and any future environment where session storage is absent.
 */

export async function sessionGet(keys) {
  if (chrome.storage?.session) return chrome.storage.session.get(keys);
  return {};
}

export async function sessionSet(data) {
  if (chrome.storage?.session) return chrome.storage.session.set(data);
}

export async function sessionRemove(keys) {
  if (chrome.storage?.session) return chrome.storage.session.remove(keys);
}
