/**
 * Structure-only refactoring mission-type promotion.
 * Utterance markers are owned by mission-classification-policy
 * (`class-code-change-refactoring-utterance`); do not duplicate them here.
 */
import { loadMissionClassificationPolicy } from './mission-classification.js';

export const REFACTORING_UTTERANCE_RULE_ID = 'class-code-change-refactoring-utterance';
export const REFACTORING_HINT_RULE_ID = 'class-code-change-refactoring-hint';

/** Patterns from the classification policy rule — single source of truth. */
export function loadRefactoringUtterancePatterns(): string[] {
  const rule = loadMissionClassificationPolicy().mission_class_rules.find(
    (entry) => entry.id === REFACTORING_UTTERANCE_RULE_ID
  );
  const patterns = rule?.match?.utterance_patterns;
  if (!Array.isArray(patterns) || patterns.length === 0) {
    throw new Error(
      `[REFACTORING_ROUTING] Missing utterance_patterns on ${REFACTORING_UTTERANCE_RULE_ID}`
    );
  }
  return patterns.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

/** True when the free-text request is structure-only refactoring. */
export function utteranceRequestsRefactoring(utterance?: string): boolean {
  if (!utterance) return false;
  const text = utterance.toLowerCase();
  return loadRefactoringUtterancePatterns().some((marker) => text.includes(marker.toLowerCase()));
}

/**
 * Promote default/feature mission types to `refactoring` when classification or
 * utterance says the work is structure-only. Explicit non-default types win.
 */
export function resolveEffectiveMissionType(input: {
  missionType?: string;
  utterance?: string;
  matchedClassRuleId?: string;
}): string | undefined {
  const current = input.missionType?.trim();
  if (current === 'refactoring') return 'refactoring';
  const promoteFromDefault = !current || current === 'development' || current === 'code_change';
  if (
    promoteFromDefault &&
    (input.matchedClassRuleId === REFACTORING_UTTERANCE_RULE_ID ||
      input.matchedClassRuleId === REFACTORING_HINT_RULE_ID ||
      utteranceRequestsRefactoring(input.utterance))
  ) {
    return 'refactoring';
  }
  return current;
}
