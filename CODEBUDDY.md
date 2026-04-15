# CODEBUDDY.md This file provides guidance to CodeBuddy when working with code in this repository.

## Project Overview

Awesome Translator is a Chrome Extension (Manifest V3) AI-powered translation agent. It provides three translation modes (Quick, Agent, Deep Analysis), context-aware translation with per-page conversation chains, rule-based intent classification (meaning vs. grammar), and streaming LLM output.

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
├── background.js          # Service worker - LLM streaming, context management, message routing
├── lib/                   # Shared business logic modules (ES modules)
│   ├── llm-client.js      # OpenAI-compatible LLM client with SSE streaming
│   ├── free-translate.js  # Free translation via Google Translate (no API key)
│   ├── intent-classifier.js  # Rule-based intent classifier (meaning vs. grammar)
│   ├── context-manager.js    # Per-tab, per-intent conversation chain manager
│   └── prompt-templates.js   # System prompt builder for quick/agent/deep modes
├── popup/                 # Extension popup UI (clicked from toolbar icon)
│   ├── popup.html         # Popup markup with mode tabs and intent selector
│   ├── popup.css          # Popup styles
│   └── popup.js           # Popup logic - mode switching, streaming, TTS
├── content/               # Content scripts injected into web pages
│   ├── content.js         # In-page translation panel with mode/intent switching, streaming, TTS
│   └── content.css        # Styles for injected UI elements (namespaced with `at-` prefix)
├── options/               # Options/settings page (full-page configuration UI)
│   ├── options.html       # Settings page: LLM config, mode, intent, TTS, user profile
│   ├── options.css        # Settings page styles
│   └── options.js         # Settings persistence logic via chrome.storage.local
└── assets/                # Icons (icon16.png, icon48.png, icon128.png)
```

### Translation Modes

| Mode | Backend | Context | Description |
|------|---------|---------|-------------|
| **Quick** | Google Translate (free) | None | Fast simple translation, no LLM required |
| **Agent** | LLM (streaming) | Page conversation chain | Context-aware translation with intent detection |
| **Deep** | LLM (streaming) | Grammar conversation chain | Word analysis: etymology, roots, usage, examples |

### Intent Classification

Rule-based (no LLM call): text ≤3 words and ≤30 chars → `grammar`; otherwise → `meaning`. User can override to manual mode. Intent determines which conversation chain to use, keeping meaning and grammar contexts isolated.

### Context Management

- Per-tab, per-intent isolated conversation chains stored in `chrome.storage.local`
- Key format: `ctx:<tabId>` → `{ meaning: [...], grammar: [...] }`
- Tab close or navigation auto-clears context
- Configurable history limit (default: 5 pairs)
- Optional user profile injected into system prompt

### Message Passing Pattern

- **Simple messages**: `GET_TRANSLATION` (popup quick), `SAVE_SETTINGS`, `TEST_LLM`, `GET_LLM_STATUS`, `SETTINGS_UPDATED`
- **Port streaming**: Content script ↔ Background via `chrome.runtime.connect({ name: 'translation' })` for agent/deep mode with SSE streaming
- **Content script**: Listens for `SETTINGS_UPDATED`, `TRANSLATE_TEXT`, `GET_SELECTED_TEXT`, `TRIGGER_TRANSLATE`

### LLM Configuration

Supports any OpenAI-compatible API endpoint. Configurable: endpoint URL, API key, model name. Includes connection test button. Works with OpenAI, DeepSeek, Ollama, vLLM, LM Studio, etc.

### Content Script Isolation

All content script CSS classes are prefixed with `at-` to avoid conflicts with host page styles.

### Permissions

`activeTab`, `storage`, `contextMenus` - defined in manifest.json. `host_permissions` for `translate.googleapis.com`.
