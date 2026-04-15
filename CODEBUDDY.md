# CODEBUDDY.md This file provides guidance to CodeBuddy when working with code in this repository.

## Project Overview

Awesome Translator is a Chrome Extension (Manifest V3) AI-powered translation agent. It provides three translation modes (Quick, Agent, Deep Analysis), context-aware translation with domain keyword extraction, rule-based intent classification (meaning vs. grammar), and streaming LLM output.

## Common Commands

### Load extension in Chrome for development
1. Open Chrome and navigate to `chrome://extensions/`
2. Enable "Developer mode" (toggle in top right)
3. Click "Load unpacked"
4. Select this project directory (the folder containing `manifest.json`)

### Reload after code changes
After modifying any JS/CSS/HTML files, click the refresh icon on the extension card in `chrome://extensions/`. The service worker (background.js) may need to be restarted via the "service worker" link.

### Package for distribution
Create a ZIP of all project files (excluding node_modules if any) for Chrome Web Store submission.

## Architecture

### File Structure & Responsibilities

```
├── manifest.json          # Extension manifest V3 (ES module service worker)
├── background.js          # Service worker - LLM streaming, context management, keyword extraction, message routing
├── lib/                   # Shared business logic modules (ES modules)
│   ├── llm-client.js      # OpenAI-compatible LLM client with SSE streaming
│   ├── free-translate.js  # Free translation via Google Translate (no API key)
│   ├── intent-classifier.js  # Rule-based intent classifier (meaning vs. grammar)
│   ├── context-manager.js    # Per-tab sentence storage + domain keyword management
│   └── prompt-templates.js   # System prompt builder with keywords + sentences context, keyword extraction prompt
├── popup/                 # Extension popup UI (clicked from toolbar icon)
│   ├── popup.html         # Popup markup with mode tabs, intent selector, keyword bar
│   ├── popup.css          # Popup styles
│   └── popup.js           # Popup logic - mode switching, streaming, TTS, keyword display
├── content/               # Content scripts injected into web pages
│   ├── content.js         # In-page translation panel with mode/intent/keyword bar, streaming, TTS
│   └── content.css        # Styles for injected UI elements (namespaced with `at-` prefix)
├── options/               # Options/settings page (full-page configuration UI)
│   ├── options.html       # Settings page: LLM config, mode, intent, TTS, user profile
│   ├── options.css        # Settings page styles
│   └── options.js         # Settings persistence logic via chrome.storage.local
├── stats/                 # Usage statistics dashboard
│   ├── stats.html         # Stats page: daily breakdown, LLM config, CSV export
│   ├── stats.css          # Stats page styles
│   └── stats.js           # Stats data fetching, table rendering, CSV export
└── assets/                # Icons (icon16.png, icon48.png, icon128.png)
```

### Translation Modes

| Mode | Backend | Context | Description |
|------|---------|---------|-------------|
| **Quick** | Google Translate (free) | None | Fast simple translation, no LLM required |
| **Agent** | LLM (streaming) | Keywords only (when available) | Context-aware translation with domain keywords, intent detection, special noun annotation |
| **Deep** | LLM (streaming) | Keywords only (when available) | Word analysis: etymology, roots, usage, examples |

### Intent Classification

Rule-based (no LLM call): text ≤3 words and ≤30 chars → `grammar`; otherwise → `meaning`. User can override to manual mode. Intent determines which context bucket to use, keeping meaning and grammar contexts isolated.

### Context Management

- Per-tab, per-intent isolated sentence storage + shared keywords stored in `chrome.storage.local`
- Key format: `ctx:<tabId>` → `{ meaning: { sentences: [], totalTranslated: 0 }, grammar: {...}, _shared: { keywords: [], totalTranslated: 0 } }`
- **Only source sentences are stored** (not translations) — saves tokens
- Domain keywords are extracted by LLM every 10 translations (or manually via refresh button)
- 5 keywords maintained per tab (shared across intents), each as `{ original, translated }` bilingual pairs
- Keywords are bilingual: `original` (English) used in backend prompts, `translated` (target language) shown in frontend
- Users can click keywords in UI to promote rank (moves to front), which triggers re-translation
- Refresh button (↻) in keyword bar forces keyword re-extraction even with <3 sentences
- Tab close or navigation auto-clears context
- When keywords exist, only keywords are injected into system prompt (sentences skipped to save tokens)
- When no keywords yet, recent sentences are injected as fallback for domain awareness
- Optional user profile injected into system prompt

### Keyword Extraction Flow

1. After each translation, source sentence is saved to context
2. When `totalTranslated` is a multiple of 10 (or first time reaching 3), LLM extracts 5 domain keywords
3. Extraction prompt includes existing keywords + recent 20 sentences for refinement
4. Keywords are stored and sent to frontend via port message
5. Frontend displays keywords as ranked tags; clicking promotes a keyword
6. `PROMOTE_KEYWORD` message moves keyword to front of array (higher rank = more relevance)

### Prompt Construction

System prompts use structured Markdown with `#` headings. Context section includes:
- `# Target Language` — target language
- `# Context` — domain keywords + recent sentences with clear instructions that sentences are for reference only
- `# Constraint` — length limits
- `# User Background` — optional user profile

Keywords and recent sentences are embedded in the system prompt (not as separate messages), reducing token waste.

### Message Passing Pattern

- **Simple messages**: `GET_TRANSLATION`, `SAVE_SETTINGS`, `TEST_LLM`, `GET_LLM_STATUS`, `SETTINGS_UPDATED`, `GET_USAGE_STATS`, `RESET_USAGE_STATS`, `PROMOTE_KEYWORD`, `GET_KEYWORDS`, `FORCE_UPDATE_KEYWORDS`, `SET_ACTIVE_ENDPOINT`
- **Port streaming**: Content script ↔ Background via `chrome.runtime.connect({ name: 'translation' })` for agent/deep mode with SSE streaming
- **Port messages**: `translate` (request), `intent`/`chunk`/`result`/`done`/`error`/`keywords` (response)
- **Content script listens**: `SETTINGS_UPDATED`, `TRANSLATE_TEXT`, `GET_SELECTED_TEXT`, `TRIGGER_TRANSLATE`, `KEYWORDS_UPDATED`

### LLM Configuration

Supports multiple LLM endpoint configurations. Each endpoint has: `id`, `name`, `endpoint` (URL), `apiKey`, `model`. Stored as `llmEndpoints` array in `chrome.storage.local`. One endpoint is marked as active via `activeEndpointId`. Auto-generates name as "model @ domain". Legacy single-config (`llmEndpoint`/`llmApiKey`/`llmModel`) is auto-migrated to the new array format. Works with OpenAI, DeepSeek, Ollama, vLLM, LM Studio, etc.

### Content Script Isolation

All content script CSS classes are prefixed with `at-` to avoid conflicts with host page styles.

### Permissions

`activeTab`, `storage`, `contextMenus` - defined in manifest.json. `host_permissions` for `translate.googleapis.com`.
