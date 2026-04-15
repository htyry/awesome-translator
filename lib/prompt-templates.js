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

# Term Annotation Format
When the original text contains terms that a general reader would find unfamiliar (proper nouns, technical terms, domain jargon, cultural references, abbreviations):
- Insert a superscript reference number after the term in the translation: e.g. "...在ARPA²的资助下..."
- List all annotated terms at the end under a **Terms** section in this exact format:

**Terms**
1. **ARPA** — 美国国防部高级研究计划局（US Defense Advanced Research Projects Agency），负责早期互联网研发的政府机构

- Use numbered references ¹²³ (unicode superscripts) in the translation body
- Each term gets exactly one line: **term** — explanation in the target language
- For truly obscure or highly important terms, provide a one-sentence explanation
- Only annotate terms that genuinely need explanation — skip common, well-known words
- Maximum 5 annotations, prioritize the most confusing terms
- If NO terms need annotation, omit the **Terms** section entirely`,

  agent_grammar: `# Role
You are an expert bilingual language learning assistant. You analyze grammar structures and help the user understand usage patterns, leveraging the conversation context when relevant.

# Output Format
Follow this format strictly using Markdown:

**Translation** <faithful translation into the target language>

**Structure** <identify and label the key grammar pattern/structure, e.g. "Subject + present perfect continuous" or "Third conditional">: \`<highlight the exact text fragment in backticks>\`

**Explanation** <clearly explain how this structure works, the grammatical rules involved, and why it's used here. If related grammar was discussed earlier, build upon that context. Be precise but concise>

**Tip** <one practical tip: a common mistake, a usage nuance, or how this pattern connects to what was discussed before — omit this section if nothing notable>`,

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

  // Domain context: keywords take priority; sentences only injected when no keywords yet
  // keywords are { original, translated } objects — use original for prompt injection
  const { keywords = [], sentences = [] } = context;
  const keywordOriginals = keywords.map(k => typeof k === 'string' ? k : k.original).filter(Boolean);
  const hasContext = keywordOriginals.length > 0 || sentences.length > 0;

  if (hasContext) {
    parts.push(`\n# Context\n> The following provides domain context from the user's recent translation session. Use it to maintain consistent terminology and domain-appropriate translations.\n`);

    if (keywordOriginals.length > 0) {
      parts.push(`**Domain Keywords:** ${keywordOriginals.join(', ')}`);
      parts.push(`Use terminology consistent with these domain keywords.`);
    }

    if (sentences.length > 0 && keywordOriginals.length === 0) {
      parts.push(`**Recent sentences translated in this session:**`);
      sentences.forEach((s, i) => {
        parts.push(`${i + 1}. ${s}`);
      });
      parts.push(`\n> The above sentences show what the user has been reading. Use them to infer the topic, domain, and preferred terminology. Do NOT translate these sentences again — they are for context only.`);
    }
  }

  // Length constraints
  if (mode === 'agent' && intent === 'meaning') {
    parts.push(`\n# Constraint\nKeep the translation concise, under 500 characters. The Terms section (if any) does not count toward this limit.`);
  } else if (mode === 'agent' && intent === 'grammar') {
    parts.push(`\n# Constraint\nKeep the total response under 500 characters.`);
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
 * Keywords are extracted as bilingual pairs: { original, translated }.
 */
export function buildKeywordPrompt(sentences, existingKeywords = [], targetLang = 'zh') {
  const sentenceList = sentences.map((s, i) => `${i + 1}. ${s}`).join('\n');

  // Normalize existing keywords to original strings for the prompt
  const existingOriginals = existingKeywords.map(k =>
    typeof k === 'string' ? k : k.original
  );

  let prompt = `Analyze the following sentences and extract domain keywords.\n\n`;
  prompt += `## Sentences\n${sentenceList}\n\n`;
  prompt += `## Task\nExtract exactly 5 domain keywords or key phrases that best represent the topic area of these sentences.\n`;
  prompt += `- Keywords should capture the subject matter, technical domain, or field\n`;
  prompt += `- Be specific (e.g., "machine learning" not "computer")\n`;
  prompt += `- The original text is in English, extract keywords in their original English form\n`;
  prompt += `- Output ONLY a JSON array of objects with "original" and "translated" fields\n`;
  prompt += `- "original" is the keyword in English (the source language)\n`;
  prompt += `- "translated" is the keyword translated into ${targetLang}\n`;
  prompt += `- Example: [{"original": "neural network", "translated": "神经网络"}]\n`;

  if (existingOriginals.length > 0) {
    prompt += `\n## Current Keywords (original language)\n${JSON.stringify(existingOriginals)}\n`;
    prompt += `Refine these keywords based on the new sentences. Keep relevant ones, replace outdated ones.\n`;
  }

  return [
    { role: 'system', content: 'You are a domain analysis assistant. Extract concise domain keywords from text. Output only valid JSON.' },
    { role: 'user', content: prompt },
  ];
}
