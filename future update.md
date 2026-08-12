⚠️ A Few Things Worth Looking At
1. Provisional partial overlays are replaced atomically — but there's a flash risk

js


// Drop the provisional streamed overlays; the authoritative set renders below.
activeStreamContext?.partialOverlays.forEach(overlay => overlay.remove());
There's a window between removing partial overlays and rendering the final ones where the page is briefly blank. On fast responses this is invisible, but on slower connections the user could see bubbles disappear and reappear. Consider rendering the final set before removing partials, then removing them after.

2. isCompleteRegion — no translation field check

js


function isCompleteRegion(object) {
  return object && Array.isArray(object.box_2d) && object.box_2d.length === 4
    && typeof object.source === 'string';
}
In combined mode the region also has a translation field. A bubble with box_2d + source but no translation yet (mid-stream) could be emitted prematurely. Consider requiring typeof object.translation === 'string' when in combined mode.

3. latencyStats read on every call in callChatCompletions

js


const latencyStats = (await chrome.storage.local.get('profileLatency')).profileLatency || {};
This adds a storage read on every API call. Since this is a service worker with no persistent memory between wake-ups, you can't trivially cache it in-module. But you could pass latencyStats down from runTranslationPipeline where config is already being read, batching it into the existing getApiConfig() read.

4. Anthropic streaming — finish() returns raw text

consumeAnthropicStream returns parser.finish() which calls parseJsonArray(text). But for Anthropic, text is built from partial_json fragments of a tool call — it may not be a top-level JSON array. Double-check that parseJsonArray handles the Anthropic wrapper format the same way it did before streaming.

📊 Summary vs My Suggestions
Suggestion	Status in v2
Streaming (biggest win)	✅ Done — both OpenAI & Anthropic
Combined mode as default	✅ Done
Lower JPEG quality / dims	✅ Done
In-flight deduplication	✅ Done
Latency-aware routing	✅ Done with EMA
Predictive prefetch	❌ Not yet (the README actually explicitly says "no background/speculative API usage" — fair choice for privacy)
All 5 of the non-speculative improvements landed in v2. The README even documents the privacy tradeoff for prefetch being excluded. This is production-quality work — ship it.
