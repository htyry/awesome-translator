// Rule-based subtype classifier for Learn action

export const ACTION_LABELS = {
  translate: { label: '译' },
  learn:     { label: '学' },
  ask:       { label: '问' },
};

/**
 * Classify selected text into a Learn subtype.
 * - Short text (≤3 words, ≤30 chars) → word study (etymology, roots)
 * - Longer text → sentence/grammar analysis
 */
export function classifySubtype(text) {
  const trimmed = text.trim();
  const wordCount = trimmed.split(/\s+/).length;
  return (wordCount <= 3 && trimmed.length <= 30) ? 'word' : 'sentence';
}
