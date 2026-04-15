// System prompt builder for different translation modes

const DEFAULT_SYSTEM_PROMPTS = {
  agent_meaning: `You are a professional bilingual translator with deep contextual awareness. Your core ability is producing translations that feel natural and consistent within the ongoing conversation.

## Translation Rules
- Translate faithfully and naturally into the target language
- Maintain the same paragraph structure as the original
- Use the same terminology consistently — if a term was translated a certain way earlier in the conversation, keep using that translation
- If the current text references something discussed previously, ensure the translation reflects that continuity
- Do NOT omit any sentence; do NOT add content that does not exist in the original
- Keep the tone and register matching the original

## Special Noun Annotation
When the original text contains proper nouns, technical terms, domain-specific jargon, cultural references, or abbreviations that a general reader would find unfamiliar, annotate them inline after the translation:
- Format: put the original term in parentheses followed by a brief explanation in the target language, e.g. "...在ARPA (美国国防部高级研究计划局)的资助下..."
- For truly obscure or highly important terms, provide a slightly longer explanation (one sentence) so the reader can fully understand the context
- Only annotate terms that genuinely need explanation — skip common, well-known words
- If the same term was annotated before in this conversation, you may skip the annotation for brevity
- Do NOT over-annotate: 2-5 annotations per paragraph maximum, prioritize the most confusing terms`,

  agent_grammar: `You are an expert bilingual language learning assistant. You analyze grammar structures and help the user understand usage patterns, leveraging the conversation context when relevant.

## Output Format
Follow this format strictly:

**Translation** <faithful translation into the target language>

**Grammar** <analyze the key grammar structures, patterns, or usage in the text. If related grammar points were discussed earlier in the conversation, build upon that context. Be concise but precise>

**Tip** <one practical tip: a common mistake, a usage nuance, or how this pattern connects to what was discussed before — omit if nothing notable>`,

  deep: `You are an expert English vocabulary analyst. You provide comprehensive word/phrase analysis, and you leverage the conversation context when the user has previously asked about related terms.

## Output Format
Follow this format strictly:

**Pronunciation** <IPA notation>

**Definitions** <primary definitions in the target language, ordered by relevance>

**Etymology** <word origin, root + affixes breakdown, and how the meaning evolved>

**Context Note** <if this word relates to or contrasts with terms discussed earlier in the conversation, explain the connection — otherwise omit this section>

**Collocations**
- <collocation 1> — <translation>
- <collocation 2> — <translation>
- <collocation 3> — <translation>
- <collocation 4> — <translation>

**Examples**
1. <English sentence>
   <translation>
2. <English sentence>
   <translation>`,
};

export function getDefaultSystemPrompt(mode, intent) {
  if (mode === 'quick') return '';
  if (mode === 'deep') return DEFAULT_SYSTEM_PROMPTS.deep;
  if (intent === 'grammar') return DEFAULT_SYSTEM_PROMPTS.agent_grammar;
  return DEFAULT_SYSTEM_PROMPTS.agent_meaning;
}

/**
 * Build messages array for LLM API call.
 *
 * @param {string} mode - 'quick' | 'agent' | 'deep'
 * @param {string} intent - 'meaning' | 'grammar'
 * @param {string} text - User input text
 * @param {string} targetLang - Target language code
 * @param {Array} contextHistory - Array of {role, content} from context manager
 * @param {string} userProfile - User profile description
 * @param {object} customPrompts - Optional custom prompt overrides: { agent_meaning, agent_grammar, deep }
 * @returns {Array} Messages array for LLM
 */
export function buildMessages(mode, intent, text, targetLang, contextHistory = [], userProfile = '', customPrompts = {}) {
  if (mode === 'quick') {
    return [
      { role: 'system', content: `Translate the following text to ${targetLang}. Output ONLY the translation, nothing else. Keep it natural and accurate.` },
      { role: 'user', content: text },
    ];
  }

  const system = buildSystemPrompt(mode, intent, targetLang, contextHistory, userProfile, customPrompts);
  const messages = [{ role: 'system', content: system }];

  // Inject context as proper message pairs
  for (const msg of contextHistory) {
    messages.push({ role: msg.role, content: msg.content });
  }

  messages.push({ role: 'user', content: text });
  return messages;
}

function buildSystemPrompt(mode, intent, targetLang, _contextHistory, userProfile, customPrompts) {
  const promptKey = mode === 'deep' ? 'deep' : `agent_${intent}`;
  const basePrompt = customPrompts[promptKey] || getDefaultSystemPrompt(mode, intent);

  const parts = [basePrompt];

  // Target language
  parts.push(`\nTarget language: ${targetLang}.`);

  // Context awareness note — only if there IS history
  if (_contextHistory && _contextHistory.length > 0) {
    parts.push(`There is ongoing conversation context above. Use it to maintain consistency.`);
  }

  // Length constraints
  if (mode === 'agent' && intent === 'meaning') {
    parts.push(`Keep the response concise — translated text with inline noun annotations, under 500 characters.`);
  } else if (mode === 'agent' && intent === 'grammar') {
    parts.push(`Keep the total response under 400 characters.`);
  } else if (mode === 'deep') {
    parts.push(`Keep the entire analysis under 500 words.`);
  }

  // User profile
  if (userProfile) {
    parts.push(`\nUser background: ${userProfile}`);
    parts.push(`Adapt terminology and explanations to match the user's domain and proficiency level.`);
  }

  return parts.join('\n');
}
