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
You are an expert vocabulary and phrase analyst. You provide comprehensive word/phrase analysis, and you leverage the conversation context when the user has previously asked about related terms.

# Output Format
Follow this format strictly:

**Pronunciation** <IPA notation if applicable>

**Definitions** <primary definitions in the target language, ordered by relevance>

**Etymology** <word origin, root + affixes breakdown, and how the meaning evolved — omit if not applicable for the language>

**Context Note** <if this word relates to or contrasts with terms discussed earlier in the conversation, explain the connection — otherwise omit this section>

**Collocations**
- <collocation 1> — <translation>
- <collocation 2> — <translation>
- <collocation 3> — <translation>
- <collocation 4> — <translation>

**Examples**
1. <example sentence in the original language>
   <translation>
2. <example sentence in the original language>
   <translation>`,

  explain: `You are a friendly and knowledgeable tutor. The user has selected some text and wants help understanding it — it could be a technical concept, a historical passage, a scientific paragraph, a legal clause, a philosophical argument, or anything else they're trying to learn about.

Your job is to explain things the way a good teacher would in a one-on-one conversation — natural, insightful, and genuinely helpful. Not like a textbook or a structured report.

Guidelines:
- Start by briefly restating what the passage says in plain language, so the user knows you understood it
- Then focus on what's actually worth explaining: unfamiliar concepts, domain-specific jargon, implicit assumptions, subtle nuances, cultural references, or anything a reader might find confusing
- Don't over-explain obvious things — use your judgment about what the user probably already knows vs. what they might be confused about
- Use analogies and comparisons when they help make abstract ideas concrete
- When a concept is best understood through examples, provide illustrative examples
- If the text is straightforward, keep your explanation short. If it's complex, go deeper. Adapt to the content.
- Write in a conversational tone, not bullet-point lists or rigid formats. It should feel like a teacher talking, not a document.
- Respond in the target language specified below.`,

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

  let prompt = `Analyze the following sentences and identify the high-level domain or field they belong to.\n\n`;
  prompt += `## Sentences\n${sentenceList}\n\n`;
  prompt += `## Task\nIdentify the broader domain, discipline, or research area that these sentences fall under. Output exactly 5 keywords/short phrases.\n`;
  prompt += `- Think at the level of academic disciplines, industry fields, or broad technical areas (e.g., "artificial intelligence", "software engineering", "biochemistry")\n`;
  prompt += `- Do NOT extract specific terms, entity names, or narrow concepts from the sentences themselves\n`;
  prompt += `- Aim for the level of abstraction that would appear as a Wikipedia category or a university department name\n`;
  prompt += `- If sentences span multiple domains, capture the top ones by relevance\n`;
  prompt += `- Output keywords in their original language form (as they appear in the text)\n`;
  prompt += `- Output ONLY a JSON array of objects with "original" and "translated" fields\n`;
  prompt += `- "original" is the keyword in the source language (as it appears in the text)\n`;
  prompt += `- "translated" is the keyword translated into ${targetLang}\n`;
  prompt += `- Example: [{"original": "computer vision", "translated": "计算机视觉"}]\n`;

  if (existingOriginals.length > 0) {
    prompt += `\n## Current Keywords (original language)\n${JSON.stringify(existingOriginals)}\n`;
    prompt += `Refine these keywords based on the new sentences. Keep relevant ones, replace outdated ones.\n`;
  }

  return [
    { role: 'system', content: 'You are a domain taxonomy assistant. Given a set of sentences, identify the high-level academic discipline, industry field, or broad technical area they belong to — similar to Wikipedia categories or university department names. Output only valid JSON.' },
    { role: 'user', content: prompt },
  ];
}

/**
 * Build messages array for Explain mode (teaching-style explanation with conversation history).
 *
 * @param {string} text - Selected text to explain
 * @param {string} question - User's question (or empty for default auto-generated)
 * @param {string} targetLang - Target language code
 * @param {object} context - { keywords: [], sentences: [] }
 * @param {string} userProfile - User profile description
 * @param {string} customPrompt - Optional custom explain prompt override
 * @param {Array} history - Previous conversation turns [{ role, content }]
 * @returns {Array} Messages array for LLM
 */
export function buildExplainMessages(text, question, targetLang, context = {}, userProfile = '', customPrompt = '', history = []) {
  const isFirstTurn = history.length === 0;
  const basePrompt = customPrompt || DEFAULT_SYSTEM_PROMPTS.explain;

  if (isFirstTurn) {
    // First turn: full system prompt with context
    const parts = [basePrompt];
    parts.push(`\n# Target Language\n${targetLang}`);

    // Inject domain context
    const { keywords = [], sentences = [] } = context;
    const keywordOriginals = keywords.map(k => typeof k === 'string' ? k : k.original).filter(Boolean);

    if (keywordOriginals.length > 0 || sentences.length > 0) {
      parts.push(`\n# Domain Context\n> The following provides domain context from the user's reading session.`);

      if (keywordOriginals.length > 0) {
        parts.push(`**Domain Keywords:** ${keywordOriginals.join(', ')}`);
      }

      if (sentences.length > 0 && keywordOriginals.length === 0) {
        parts.push(`**Previously read sentences:**`);
        sentences.forEach((s, i) => { parts.push(`${i + 1}. ${s}`); });
        parts.push(`> These sentences are for context only — do not re-explain them unless relevant.`);
      }
    }

    if (userProfile) {
      parts.push(`\n# User Background\n${userProfile}`);
      parts.push(`Adapt explanations to match the user's domain knowledge and proficiency level.`);
    }

    parts.push(`\n# Text to Explain\n${text}`);

    // Default question if user didn't provide one
    const userQuestion = question || `Can you explain this text? Point out anything that might be confusing or easy to misunderstand.`;

    return [
      { role: 'system', content: parts.join('\n') },
      { role: 'user', content: userQuestion },
    ];
  } else {
    // Follow-up turns: brief system reminder + conversation history + new question
    const systemParts = [basePrompt];
    systemParts.push(`\n# Target Language\n${targetLang}`);
    systemParts.push(`\n# Text Under Discussion\n${text}`);
    if (userProfile) {
      systemParts.push(`\n# User Background\n${userProfile}`);
    }
    systemParts.push(`\nContinue the conversation naturally. The user is asking a follow-up question about the text. Be concise and directly answer their question.`);

    const messages = [
      { role: 'system', content: systemParts.join('\n') },
    ];

    // Append conversation history (clean Q&A pairs only)
    for (const turn of history) {
      messages.push({ role: turn.role, content: turn.content });
    }

    // Add the new question
    messages.push({ role: 'user', content: question });

    return messages;
  }
}
