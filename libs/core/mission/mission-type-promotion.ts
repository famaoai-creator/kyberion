/**
 * Mission-type promotion for code-change specializations.
 *
 * A default (`development` / `code_change` / unset) mission type is promoted to
 * a specialized code-change type when the classification policy says the work
 * is one: structure-only refactoring, spec extraction from existing code
 * (reverse_spec), or a legacy rebuild (legacy_migration). Utterance markers are
 * owned by mission-classification-policy rules; this table only names which
 * rule ids promote to which type — do not duplicate the markers here.
 *
 * Order is precedence: a request that mentions both extracting a spec and a
 * migration starts with reverse_spec (a migration needs an audited spec first).
 */
import { loadMissionClassificationPolicy } from './mission-classification.js';

export interface MissionTypePromotion {
  missionType: string;
  hintRuleId: string;
  utteranceRuleId: string;
}

export const MISSION_TYPE_PROMOTIONS: readonly MissionTypePromotion[] = [
  {
    missionType: 'reverse_spec',
    hintRuleId: 'class-code-change-reverse-spec-hint',
    utteranceRuleId: 'class-code-change-reverse-spec-utterance',
  },
  {
    missionType: 'legacy_migration',
    hintRuleId: 'class-code-change-legacy-migration-hint',
    utteranceRuleId: 'class-code-change-legacy-migration-utterance',
  },
  {
    missionType: 'refactoring',
    hintRuleId: 'class-code-change-refactoring-hint',
    utteranceRuleId: 'class-code-change-refactoring-utterance',
  },
];

const PROMOTABLE_DEFAULT_TYPES = new Set(['development', 'code_change']);

export const REFACTORING_UTTERANCE_RULE_ID = 'class-code-change-refactoring-utterance';
export const REFACTORING_HINT_RULE_ID = 'class-code-change-refactoring-hint';

/** Utterance markers of one promotion rule, read from the classification policy. */
export function loadPromotionUtterancePatterns(utteranceRuleId: string): string[] {
  const rule = loadMissionClassificationPolicy().mission_class_rules.find(
    (entry) => entry.id === utteranceRuleId
  );
  const patterns = rule?.match?.utterance_patterns;
  if (!Array.isArray(patterns) || patterns.length === 0) {
    throw new Error(`[MISSION_TYPE_PROMOTION] Missing utterance_patterns on ${utteranceRuleId}`);
  }
  return patterns.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

function utteranceMatches(utterance: string | undefined, utteranceRuleId: string): boolean {
  if (!utterance) return false;
  const text = utterance.toLowerCase();
  return loadPromotionUtterancePatterns(utteranceRuleId).some((marker) =>
    text.includes(marker.toLowerCase())
  );
}

/** Specialized code-change type requested by the free text, if any (precedence order). */
export function resolveUtteranceMissionType(utterance?: string): string | undefined {
  return MISSION_TYPE_PROMOTIONS.find((entry) => utteranceMatches(utterance, entry.utteranceRuleId))
    ?.missionType;
}

/** Patterns from the refactoring classification rule — single source of truth. */
export function loadRefactoringUtterancePatterns(): string[] {
  return loadPromotionUtterancePatterns(REFACTORING_UTTERANCE_RULE_ID);
}

/** True when the free-text request is structure-only refactoring. */
export function utteranceRequestsRefactoring(utterance?: string): boolean {
  return utteranceMatches(utterance, REFACTORING_UTTERANCE_RULE_ID);
}

/**
 * Promote default/feature mission types to a specialized code-change type when
 * classification or utterance says so. Explicit non-default types win.
 */
export function resolveEffectiveMissionType(input: {
  missionType?: string;
  utterance?: string;
  matchedClassRuleId?: string;
}): string | undefined {
  const current = input.missionType?.trim();
  if (current && MISSION_TYPE_PROMOTIONS.some((entry) => entry.missionType === current))
    return current;
  if (current && !PROMOTABLE_DEFAULT_TYPES.has(current)) return current;
  const byRule = MISSION_TYPE_PROMOTIONS.find(
    (entry) =>
      input.matchedClassRuleId === entry.utteranceRuleId ||
      input.matchedClassRuleId === entry.hintRuleId
  );
  return byRule?.missionType ?? resolveUtteranceMissionType(input.utterance) ?? current;
}
