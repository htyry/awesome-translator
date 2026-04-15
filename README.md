# Awesome Translator

> AI-Powered Translation Agent for Chrome — built with **vibe coding** (AI-assisted development).

A smart Chrome extension (Manifest V3) that goes beyond simple translation. It provides **context-aware multi-turn translation**, **deep word analysis**, and **special noun annotation** — all powered by any OpenAI-compatible LLM of your choice.

## Features

### Three Translation Modes

| Mode | Description |
|------|-------------|
| **Quick** | Fast translation via Google Translate — no API key required |
| **Context (Agent)** | LLM-powered translation with conversation memory, context continuity, and inline annotation for unfamiliar terms |
| **Deep Analysis** | Comprehensive word study: pronunciation, definitions, etymology, collocations, and examples |

### Key Capabilities

- **Context Memory** — Per-tab, per-intent isolated conversation chains. The translator remembers previous translations in the same page, maintaining consistent terminology across multiple queries.
- **Smart Intent Detection** — Automatically classifies input as "meaning" (semantic translation) or "grammar" (structural analysis) based on input length. User can override manually.
- **Special Noun Annotation** — In Context mode, unfamiliar proper nouns, technical terms, and cultural references are annotated inline with brief explanations.
- **LLM Agnostic** — Works with any OpenAI-compatible API: OpenAI, DeepSeek, Ollama, LM Studio, vLLM, etc.
- **Streaming Output** — Real-time SSE streaming for LLM responses.
- **TTS (Text-to-Speech)** — Built-in speech synthesis for both original and translated text.
- **Keyboard Shortcuts** — `Alt+Shift+O` to open popup, `Alt+Shift+T` to translate selected text directly.
- **Usage Statistics** — Track daily API usage by mode, model, and endpoint. Standalone stats dashboard with CSV export.

## Screenshots

*(Screenshots coming soon — add them after first use!)*

## Installation

### From Source (Developer Mode)

1. Clone or download this repository
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the project folder
5. The extension icon appears in your toolbar

### Configure LLM (for Context/Deep modes)

1. Right-click the extension icon → **Options**
2. Enter your LLM endpoint URL and API key
3. Set the model name
4. Click **Test Connection** to verify
5. Save settings

> Quick mode works immediately without any LLM configuration.

## Usage

1. **Select text** on any webpage
2. Press `Alt+Shift+T` or click the extension icon
3. Choose a translation mode:
   - **Quick** — instant translation, no setup needed
   - **Context** — context-aware translation with terminology consistency
   - **Deep** — in-depth vocabulary analysis
4. Read the streaming result in the panel

### Content Script Panel

When you use `Alt+Shift+T`, an inline panel appears on the page. You can switch modes, change intent (meaning/grammar), and read text aloud — all without leaving the page.

## Project Structure

```
├── manifest.json              # Extension manifest V3
├── background.js              # Service worker: LLM streaming, message routing, usage tracking
├── lib/
│   ├── llm-client.js          # OpenAI-compatible LLM client with SSE streaming
│   ├── free-translate.js      # Free translation via Google Translate
│   ├── intent-classifier.js   # Rule-based intent classifier (meaning vs. grammar)
│   ├── context-manager.js     # Per-tab conversation chain manager
│   └── prompt-templates.js    # System prompt builder for all modes
├── popup/                     # Toolbar popup UI
├── content/                   # Injected in-page translation panel
├── options/                   # Settings & configuration page
├── stats/                     # Usage statistics dashboard
└── assets/                    # Extension icons
```

## Tech Stack

- **Platform**: Chrome Extension Manifest V3
- **Language**: Vanilla JavaScript (ES Modules)
- **UI**: HTML + CSS (no framework)
- **LLM**: OpenAI-compatible API via SSE streaming
- **Storage**: `chrome.storage.local`
- **Free Translation**: Google Translate API (no key needed)

## Built With Vibe Coding

This project was developed entirely through **vibe coding** — describing requirements in natural language and iterating with an AI coding assistant to produce the complete codebase. No traditional hand-coding was involved. The workflow:

1. Describe features and requirements in plain language
2. AI generates code, architecture, and UI
3. Test, report issues, refine through conversation
4. Iterate until polished

If you find issues or have feature ideas, feel free to open an issue or PR!

## License

MIT
