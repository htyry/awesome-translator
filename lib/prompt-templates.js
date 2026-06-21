// System prompt builder for the three core actions: translate / learn / ask
// Prompts are intentionally short, direct, and single-purpose.

const DEFAULT_SYSTEM_PROMPTS = {
  // ── 译 Translate: faithful, context-aware translation with inline term notes ──
  translate: `You are a professional translator. Translate the user's text into the target language.

Rules:
- Be faithful and natural. Do not omit or add content.
- Keep the original tone, register, and paragraph structure.
- Reuse terminology consistent with the domain context below (if provided), so repeated terms stay consistent across the page.

Term notes (only when needed):
- If the text contains proper nouns, jargon, abbreviations, or cultural references a general reader may not know, mark them with a superscript number in the translation (e.g. "在ARPA¹的资助下").
- List them once at the end under a **Terms** section, one per line: \`**term** — one short explanation in the target language\`.
- Max 5 notes. Skip common words. If nothing needs a note, omit the Terms section entirely.

Output only the translation (plus the optional Terms section). No preamble.`,

  // ── 学 Learn (word/phrase): etymology, roots, usage ──
  learn_word: `You are a vocabulary coach. The user selected a word or short phrase to study. Help them truly understand and remember it.

Output in the target language, using this structure (omit any section that does not apply):

**Pronunciation** <IPA>
**Meaning** <core definitions, ordered by how common they are>
**Roots** <break into root / prefix / suffix, explain what each part means and how they build the word>
**Origin** <brief etymology — where it comes from and how the meaning evolved>
**Collocations**
- <common collocation> — <translation>
- <common collocation> — <translation>
**Examples**
1. <natural example sentence> — <translation>
2. <natural example sentence> — <translation>

Be precise and concise. Prioritize what helps memory and real usage.`,

  // ── 学 Learn (sentence): grammar structure analysis ──
  learn_sentence: `You are a language tutor. The user selected a sentence or longer phrase and wants to understand how it works grammatically.

Output in the target language, using this structure:

**Translation** <faithful translation>
**Structure** <name the key grammar pattern, e.g. "present perfect continuous", "third conditional"> — \`<quote the exact fragment>\`
**Explanation** <how the structure works and why it's used here. Be clear and concise.>
**Tip** <one practical note: a common mistake or usage nuance — omit if nothing notable>

Keep it focused. Do not analyze every word, only what matters for understanding the structure.`,

  // ── 问 Ask: conversational, teaching-style explanation ──
  ask: `You are a friendly, knowledgeable tutor. The user selected some text and wants to understand it — a concept, a passage, an argument, anything.

Explain it the way a good teacher would one-on-one:
- Briefly restate the gist in plain language so they know you understood it.
- Then focus on what's actually worth explaining: unfamiliar concepts, jargon, hidden assumptions, subtle nuances, or easy-to-misread parts.
- Skip the obvious. Use analogies and examples when they make abstract ideas concrete.
- Short for simple text, deeper for complex text. Conversational tone, not rigid bullet templates.
- Respond in the target language.`,
};

/**
 * Resolve which default prompt to use for a given action + subtype.
 * @param {string} action - 'translate' | 'learn' | 'ask'
 * @param {string} subtype - for learn: 'word' | 'sentence'
 */
export function getDefaultSystemPrompt(action, subtype) {
  if (action === 'learn') {
    return subtype === 'word' ? DEFAULT_SYSTEM_PROMPTS.learn_word : DEFAULT_SYSTEM_PROMPTS.learn_sentence;
  }
  if (action === 'ask') return DEFAULT_SYSTEM_PROMPTS.ask;
  return DEFAULT_SYSTEM_PROMPTS.translate;
}

/**
 * Build messages array for translate / learn actions.
 *
 * @param {string} action - 'translate' | 'learn'
 * @param {string} subtype - 'word' | 'sentence' (learn only; ignored for translate)
 * @param {string} text - User input text
 * @param {string} targetLang - Target language code
 * @param {object} context - { sentences: string[], keywords: object[] }
 * @param {string} userProfile - User profile description
 * @param {object} customPrompts - Optional custom prompt overrides keyed by action
 * @returns {Array} Messages array for LLM
 */
export function buildMessages(action, subtype, text, targetLang, context = {}, userProfile = '', customPrompts = {}) {
  const base = customPrompts[action] || getDefaultSystemPrompt(action, subtype);
  const parts = [base];

  parts.push(`\n# Target Language\n${targetLang}`);

  // Domain context: keywords take priority; recent sentences only when no keywords yet.
  const { keywords = [], sentences = [] } = context;
  const keywordOriginals = keywords.map(k => (typeof k === 'string' ? k : k.original)).filter(Boolean);

  if (keywordOriginals.length > 0 || sentences.length > 0) {
    parts.push(`\n# Domain Context\n> From the user's recent reading on this page. Use it to keep terminology consistent and domain-appropriate.`);
    if (keywordOriginals.length > 0) {
      parts.push(`Keywords: ${keywordOriginals.join(', ')}`);
    } else if (sentences.length > 0) {
      parts.push(`Recently read (for reference only, do NOT re-translate):`);
      sentences.forEach((s, i) => parts.push(`${i + 1}. ${s}`));
    }
  }

  // Length guardrails per action + subtype
  if (action === 'translate') {
    parts.push(`\n# Limit\nKeep the translation under 500 characters. The Terms section does not count.`);
  } else if (action === 'learn' && subtype === 'sentence') {
    parts.push(`\n# Limit\nKeep the analysis under 400 words.`);
  } else if (action === 'learn' && subtype === 'word') {
    parts.push(`\n# Constraint\nBe thorough but concise. Prioritize accuracy over completeness when tight. Aim for around 200–350 words total.`);
  }

  if (userProfile) {
    parts.push(`\n# User Background\n${userProfile}\nAdapt terminology and depth to this background.`);
  }

  return [
    { role: 'system', content: parts.join('\n') },
    { role: 'user', content: text },
  ];
}

/**
 * Build prompt for LLM-based domain keyword extraction.
 * Keywords are extracted as bilingual pairs: { original, translated }.
 */
export function buildKeywordPrompt(sentences, existingKeywords = [], targetLang = 'zh') {
  const sentenceList = sentences.map((s, i) => `${i + 1}. ${s}`).join('\n');
  const existingOriginals = existingKeywords.map(k => (typeof k === 'string' ? k : k.original));

  let prompt = `Identify the high-level domain or field these sentences belong to.\n\n`;
  prompt += `## Sentences\n${sentenceList}\n\n`;
  prompt += `## Task\nOutput exactly 5 keywords/short phrases naming the broad discipline, industry, or technical area (think Wikipedia category or university department — e.g. "artificial intelligence", "biochemistry").\n`;
  prompt += `- Do NOT extract narrow terms or entity names from the sentences.\n`;
  prompt += `- "original": the keyword in the source language; "translated": its ${targetLang} translation.\n`;
  prompt += `- Output ONLY a JSON array, e.g. [{"original": "computer vision", "translated": "计算机视觉"}]\n`;

  if (existingOriginals.length > 0) {
    prompt += `\n## Current Keywords\n${JSON.stringify(existingOriginals)}\nRefine these based on the new sentences. Keep relevant ones, replace outdated ones.\n`;
  }

  return [
    { role: 'system', content: 'You identify the high-level domain of a text. Output only valid JSON.' },
    { role: 'user', content: prompt },
  ];
}

/**
 * Build messages array for Ask mode (teaching-style explanation with conversation history).
 *
 * @param {string} text - Selected text to explain
 * @param {string} question - User's question (empty → default explanation)
 * @param {string} targetLang - Target language code
 * @param {object} context - { keywords: [], sentences: [] }
 * @param {string} userProfile - User profile description
 * @param {string} customPrompt - Optional custom ask prompt override
 * @param {Array} history - Previous turns [{ role, content }]
 * @returns {Array} Messages array for LLM
 */
export function buildExplainMessages(text, question, targetLang, context = {}, userProfile = '', customPrompt = '', history = []) {
  const isFirstTurn = history.length === 0;
  const basePrompt = customPrompt || DEFAULT_SYSTEM_PROMPTS.ask;

  if (isFirstTurn) {
    const parts = [basePrompt];
    parts.push(`\n# Target Language\n${targetLang}`);

    const { keywords = [], sentences = [] } = context;
    const keywordOriginals = keywords.map(k => (typeof k === 'string' ? k : k.original)).filter(Boolean);

    if (keywordOriginals.length > 0 || sentences.length > 0) {
      parts.push(`\n# Domain Context\n> From the user's reading session on this page.`);
      if (keywordOriginals.length > 0) {
        parts.push(`Keywords: ${keywordOriginals.join(', ')}`);
      } else if (sentences.length > 0) {
        parts.push(`Recently read (for reference only):`);
        sentences.forEach((s, i) => parts.push(`${i + 1}. ${s}`));
      }
    }

    if (userProfile) {
      parts.push(`\n# User Background\n${userProfile}\nAdapt explanations to this background.`);
    }

    parts.push(`\n# Text to Explain\n${text}`);

    const userQuestion = question || `Explain this text. Point out anything confusing or easy to misunderstand.`;

    return [
      { role: 'system', content: parts.join('\n') },
      { role: 'user', content: userQuestion },
    ];
  }

  // Follow-up turns: brief system reminder + history + new question
  const systemParts = [basePrompt];
  systemParts.push(`\n# Target Language\n${targetLang}`);
  systemParts.push(`\n# Text Under Discussion\n${text}`);
  if (userProfile) systemParts.push(`\n# User Background\n${userProfile}`);
  systemParts.push(`\nContinue the conversation. Answer the follow-up directly and concisely.`);

  const messages = [{ role: 'system', content: systemParts.join('\n') }];
  for (const turn of history) messages.push({ role: turn.role, content: turn.content });
  messages.push({ role: 'user', content: question });
  return messages;
}
