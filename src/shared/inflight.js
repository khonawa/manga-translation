export function createInflightEntry(controller = new AbortController()) {
  return { controller, subscribers: new Map(), promise: null };
}

export function addInflightSubscriber(entry, requestId, tabId) {
  entry.subscribers.set(requestId, { requestId, tabId });
}

export function removeInflightSubscriber(entry, requestId) {
  const removed = entry.subscribers.delete(requestId);
  if (removed && entry.subscribers.size === 0 && !entry.controller.signal.aborted) {
    entry.controller.abort();
  }
  return removed;
}

export function listInflightSubscribers(entry) {
  return [...entry.subscribers.values()];
}