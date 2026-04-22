/**
 * Intent Extractor — pulls a structured IntentBody (goal, constraints,
 * deliverables, stakeholders) from a user utterance or mission brief.
 *
 * Implements the missing "utterance → intent body" step that lets the
 * intent-drift gate actually see drift. Same register/get/reset pattern
 * as ReasoningBackend and VoiceBridge.
 */

import { logger } from './core.js';
import type { IntentBody } from './intent-delta.js';

export interface ExtractIntentInput {
  text: string;
  /** Optional conversation / mission context that precedes this utterance. */
  context?: Record<string, unknown>;
}

export interface IntentExtractor {
  name: string;
  extract(input: ExtractIntentInput): Promise<IntentBody>;
}

let registered: IntentExtractor | null = null;

export function registerIntentExtractor(extractor: IntentExtractor): void {
  registered = extractor;
}

export function getIntentExtractor(): IntentExtractor {
  return registered ?? stubIntentExtractor;
}

export function resetIntentExtractor(): void {
  registered = null;
}

function summarizeGoal(text: string): string {
  const firstLine = text
    .split(/\r?\n/u)
    .map((l) => l.trim())
    .filter(Boolean)[0] ?? text.trim();
  if (firstLine.length <= 200) return firstLine;
  return `${firstLine.slice(0, 197)}...`;
}

/**
 * Deterministic fallback extractor. Uses the first non-empty line as the
 * goal and harvests simple stakeholder @-mentions. No LLM needed; good
 * enough for "something changed" drift detection.
 */
export const stubIntentExtractor: IntentExtractor = {
  name: 'stub',

  async extract(input) {
    if (!input.text || input.text.trim() === '') {
      logger.warn('[intent-extractor:stub] empty text — returning placeholder goal');
      return { goal: '(no utterance)' };
    }
    const stakeholders = Array.from(
      new Set(
        (input.text.match(/@[A-Za-z0-9_\-.]+/gu) ?? []).map((m) => m.slice(1)),
      ),
    );
    const body: IntentBody = { goal: summarizeGoal(input.text) };
    if (stakeholders.length > 0) body.stakeholders = stakeholders;
    return body;
  },
};
