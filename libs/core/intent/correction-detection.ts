const HIGH_CONFIDENCE_CORRECTION_PATTERNS: Array<RegExp | string> = [
  /^(?:no|nope|nah|wrong|incorrect|not(?:\s+like)?\s+that|not\s+that)\b/i,
  /\b(?:change|fix|retry|redo|re-run|reopen|reopen it|start over|do over)\b/i,
  /違う|ちがう|違います|そうじゃない|それではない|別|やり直し|訂正|修正|再度|もう一度|前の?じゃない/,
];

function matchesPattern(text: string, pattern: RegExp | string): boolean {
  if (typeof pattern === 'string') {
    return text.toLowerCase().includes(pattern.toLowerCase());
  }
  return pattern.test(text);
}

/**
 * Deterministic correction detector used for re-entry/backtrack routing.
 * Keep the surface narrow and high-confidence so ordinary follow-up answers
 * do not get treated as a correction.
 */
export function isCorrectionUtterance(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return false;
  return HIGH_CONFIDENCE_CORRECTION_PATTERNS.some((pattern) => matchesPattern(normalized, pattern));
}
