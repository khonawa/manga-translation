# Manga Screen Translator

A Chrome extension (Manifest V3) that translates manga, manhwa, and webtoon speech bubbles in place. Draw a box around a panel and the extension captures that region, sends it to a vision-capable AI provider, and renders the translated text back over the original bubbles — streamed in bubble-by-bubble as the model writes them.

## Features

- **Region snipping** — drag a box around any panel to translate just that area.
- **Full-page translation** — translate everything visible on screen in one shot.
- **Streaming rendering** — translated bubbles appear one at a time as the model generates them, instead of waiting for the full response.
- **Combined OCR + translation** — a single AI call locates, transcribes, and translates text (a two-stage mode is available as an opt-in for cheaper retries).
- **Multiple providers** — OpenAI, Gemini, Anthropic, and local runtimes (Ollama, LM Studio), plus any OpenAI-compatible endpoint.
- **API rotation & failover** — configure several API profiles; requests rotate across them, fall over automatically on error, and prefer the fastest based on measured latency.
- **Smart caching** — translations are cached by image content hash for 30 days, so re-snipping a region is instant. Duplicate in-flight requests are deduplicated.
- **Persistent overlays** — translations are restored when you revisit a page.
- **Flexible display** — overlay bubbles (adaptive/rectangle/oval), side-panel list, adjustable fonts, colors, sizing, and reading order (RTL/LTR).
- **Screenshots** — save a region or the visible page as an image.
- **Usage tracking** — per-request token and cost estimates.

## Installation (unpacked / development)

1. Clone or download this repository.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode** (top right).
4. Click **Load unpacked** and select this folder.
5. The options page opens automatically on first install — configure a provider there.

## Setup

1. Open the extension **Settings** (right-click the toolbar icon → Options, or via the popup).
2. Choose a provider and enter its endpoint, model, and API key.
3. Click **Test All Enabled APIs** to verify the connection.
4. Optionally add more API profiles for rotation/failover, set source/target languages, and customize appearance.

API keys are stored in Chrome extension storage on your device. Enable **"Keep key only until Chrome closes"** to use session-only storage instead.

## Usage

| Action | Shortcut | Description |
| --- | --- | --- |
| Start Snip Translation | `Alt+Q` | Draw a box around a panel to translate it |
| Translate Visible Screen | `Alt+1` | Translate everything currently visible |
| Save Region Screenshot | `Alt+2` | Capture a region to your downloads |
| Save Visible Screen Screenshot | `Alt+3` | Capture the visible page |
| Clear Overlays | — | Remove all translation overlays |

Shortcuts can be remapped at `chrome://extensions/shortcuts`.

Right-click a translated bubble (or focus it and press `Enter`) for actions, `F2` to edit the text inline, and drag to reposition it.

## How it works

```
Snip region
  → captureVisibleTab (PNG)
  → crop + re-encode JPEG in the service worker (OffscreenCanvas)
  → POST to AI provider (streaming SSE)
      ├─ combined mode: one call returns boxes + translations
      └─ separate mode: OCR call, then a translation call
  → stream each bubble to the page as its JSON completes
  → render overlays / cache result / record usage
```

Key design points:

- **Crop in the worker** — the region is cropped and encoded once in the service worker, avoiding a lossy re-encode and a multi-megabyte round trip through the content script.
- **Structured output** — providers that support it get a strict JSON schema (OpenAI `response_format`, Anthropic forced tool call), which makes malformed responses effectively impossible. Local runtimes fall back to a lenient parser.
- **Latency-aware routing** — each profile's response time is tracked as an exponential moving average; the fastest healthy profile is preferred.

## Project structure

```
manifest.json        Extension manifest (MV3)
background.js        Service worker: capture, API calls, caching, routing, streaming
content.js           Content script: snipping UI, overlay rendering, page sessions
popup.html/.js       Toolbar popup: quick actions and display settings
options.html/.js     Settings page: providers, languages, appearance, usage
styles.css           Overlay and bubble styles
src/shared/
  providers.js       Provider presets and pricing
  schema.js          Structured-output schemas (OCR / combined / translation)
  parse.js           Lenient JSON parsing + streaming region extractor
  bubbles.js         Bubble validation/normalization
  routing.js         API profile normalization, rotation, latency ordering
  theme.css          Shared dark theme variables
test/                Node test suite for the shared modules
icons/               Extension icons
```

## Development

The extension loads unbundled; `package.json` only provides linting and tests.

```bash
npm run lint    # ESLint
npm test        # node --test test/*.test.js
```

After editing, reload the extension at `chrome://extensions` (and refresh the target page for content-script changes).

## Privacy & cost notes

- The extension only calls an AI provider when you explicitly translate something. There is no background/speculative API usage.
- Translations are cached locally (30-day TTL, ~20 MB cap) and never leave your device except as the image payload sent to your configured provider.
- Each translation consumes provider tokens; usage and estimated cost are shown in Settings.
