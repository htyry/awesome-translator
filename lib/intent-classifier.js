// Rule-based intent classifier

export const INTENT_LABELS = {
  meaning: { label: 'Meaning' },
  grammar: { label: 'Grammar' },
};

export const MODE_LABELS = {
  quick: { label: 'Quick' },
  agent: { label: 'Context' },
  deep:  { label: 'Deep' },
};

/**
 * Classify user intent based on text characteristics.
 * - Short text (≤3 words, ≤30 chars) → grammar learning
 * - Longer text → meaning understanding
 */
export function classifyIntent(text) {
  const trimmed = text.trim();
  const wordCount = trimmed.split(/\s+/).length;
  const charCount = trimmed.length;
  if (wordCount <= 3 && charCount <= 30) return 'grammar';
  return 'meaning';
}
