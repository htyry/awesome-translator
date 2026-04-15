// System prompt builder for different translation modes

const DEFAULT_SYSTEM_PROMPTS = {
  agent_meaning: `# Role
You are a professional bilingual translator with deep domain awareness.

# Translation Rules
- Translate faithfully and naturally into the target language
- Maintain the same paragraph structure as the original
- Do NOT omit any sentence; do NOT add content that does not exist in the original
- Keep the tone and register matching the original text

# Terminology Consistency
- Use the same terminology consistently throughout the conversation
- If a term was translated a certain way previously, keep using that translation
- If the current text references something discussed in earlier sentences, ensure the translation reflects that continuity

# Special Noun Annotation
When the original text contains terms that a general reader would find unfamiliar (proper nouns, technical terms, domain jargon, cultural references, abbreviations):
- Annotate inline after the translation in parentheses: \`...the ARPA (US Defense Advanced Research Projects Agency) funding...\`
- For truly obscure or highly important terms, provide a slightly longer explanation (one sentence)
- Only annotate terms that genuinely need explanation — skip common, well-known words
- 2-5 annotations per paragraph maximum, prioritize the most confusing terms`,

  agent_grammar: `# Role
You are an expert bilingual language learning assistant. You analyze grammar structures and help the user understand usage patterns, leveraging the conversation context when relevant.

# Output Format
Follow this format strictly:

**Translation** <faithful translation into the target language>

**Grammar** <analyze the key grammar structures, patterns, or usage in the text. If related grammar points were discussed earlier, build upon that context. Be concise but precise>

**Tip** <one practical tip: a common mistake, a usage nuance, or how this pattern connects to what was discussed before — omit if nothing notable>`,

  deep: `# Role
You are an expert English vocabulary analyst. You provide comprehensive word/phrase analysis, and you leverage the conversation context when the user has previously asked about related terms.

# Output Format
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
 * @param {object} context - { sentences: string[], keywords: string[] }
 * @param {string} userProfile - User profile description
 * @param {object} customPrompts - Optional custom prompt overrides
 * @returns {Array} Messages array for LLM
 */
export function buildMessages(mode, intent, text, targetLang, context = {}, userProfile = '', customPrompts = {}) {
  if (mode === 'quick') {
    return [
      { role: 'system', content: `Translate the following text to ${targetLang}. Output ONLY the translation, nothing else. Keep it natural and accurate.` },
      { role: 'user', content: text },
    ];
  }

  const system = buildSystemPrompt(mode, intent, targetLang, context, userProfile, customPrompts);
  return [
    { role: 'system', content: system },
    { role: 'user', content: text },
  ];
}

function buildSystemPrompt(mode, intent, targetLang, context, userProfile, customPrompts) {
  const promptKey = mode === 'deep' ? 'deep' : `agent_${intent}`;
  const basePrompt = customPrompts[promptKey] || getDefaultSystemPrompt(mode, intent);

  const parts = [basePrompt];

  // Target language
  parts.push(`\n# Target Language\n${targetLang}`);

  // Domain context (keywords + recent sentences)
  const { keywords = [], sentences = [] } = context;
  const hasContext = keywords.length > 0 || sentences.length > 0;

  if (hasContext) {
    parts.push(`\n# Context\n> The following provides domain context from the user's recent translation session. Use it to maintain consistent terminology and domain-appropriate translations.\n`);

    if (keywords.length > 0) {
      parts.push(`**Domain Keywords:** ${keywords.join(', ')}`);
      parts.push(`Use terminology consistent with these domain keywords.\n`);
    }

    if (sentences.length > 0) {
      parts.push(`**Recent sentences translated in this session:**`);
      sentences.forEach((s, i) => {
        parts.push(`${i + 1}. ${s}`);
      });
      parts.push(`\n> The above sentences show what the user has been reading. Use them to infer the topic, domain, and preferred terminology. Do NOT translate these sentences again — they are for context only.`);
    }
  }

  // Length constraints
  if (mode === 'agent' && intent === 'meaning') {
    parts.push(`\n# Constraint\nKeep the response concise — translated text with inline noun annotations, under 500 characters.`);
  } else if (mode === 'agent' && intent === 'grammar') {
    parts.push(`\n# Constraint\nKeep the total response under 400 characters.`);
  } else if (mode === 'deep') {
    parts.push(`\n# Constraint\nKeep the entire analysis under 500 words.`);
  }

  // User profile
  if (userProfile) {
    parts.push(`\n# User Background\n${userProfile}`);
    parts.push(`Adapt terminology and explanations to match the user's domain and proficiency level.`);
  }

  return parts.join('\n');
}

/**
 * Build prompt for LLM-based keyword extraction.
 * Used to analyze sentences and generate domain keywords.
 */
export function buildKeywordPrompt(sentences, existingKeywords = []) {
  const sentenceList = sentences.map((s, i) => `${i + 1}. ${s}`).join('\n');

  let prompt = `Analyze the following sentences and extract domain keywords.\n\n`;
  prompt += `## Sentences\n${sentenceList}\n\n`;
  prompt += `## Task\nExtract exactly 5 domain keywords or key phrases that best represent the topic area of these sentences.\n`;
  prompt += `- Keywords should capture the subject matter, technical domain, or field\n`;
  prompt += `- Be specific (e.g., "machine learning" not "computer")\n`;
  prompt += `- Use English for the keywords\n`;
  prompt += `- Output ONLY a JSON array of strings, nothing else\n`;

  if (existingKeywords.length > 0) {
    prompt += `\n## Current Keywords\n${JSON.stringify(existingKeywords)}\n`;
    prompt += `Refine these keywords based on the new sentences. Keep relevant ones, replace outdated ones.\n`;
  }

  return [
    { role: 'system', content: 'You are a domain analysis assistant. Extract concise domain keywords from text. Output only valid JSON.' },
    { role: 'user', content: prompt },
  ];
}
