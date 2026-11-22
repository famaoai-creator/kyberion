import { describe, expect, it } from 'vitest';
import { assertRefactoringEvidence } from './refactoring-evidence.js';
import {
  loadRefactoringUtterancePatterns,
  resolveEffectiveMissionType,
  utteranceRequestsRefactoring,
} from './mission-type-promotion.js';
import { loadMissionClassificationPolicy } from './mission-classification.js';

describe('refactoring evidence and mission-type promotion', () => {
  it('loads utterance markers from classification policy (no hardcoded twin list)', () => {
    const fromPolicy = loadMissionClassificationPolicy().mission_class_rules.find(
      (rule) => rule.id === 'class-code-change-refactoring-utterance'
    )?.match?.utterance_patterns;
    expect(loadRefactoringUtterancePatterns()).toEqual(fromPolicy);
    expect(loadRefactoringUtterancePatterns().length).toBeGreaterThan(0);
  });

  it('detects refactoring utterances and promotes default mission types', () => {
    expect(utteranceRequestsRefactoring('このモジュールをリファクタリングして')).toBe(true);
    expect(utteranceRequestsRefactoring('add a feature flag')).toBe(false);
    expect(
      resolveEffectiveMissionType({
        missionType: 'development',
        utterance: 'refactor this module for readability',
      })
    ).toBe('refactoring');
    expect(
      resolveEffectiveMissionType({
        missionType: 'presentation_production',
        utterance: 'リファクタリングして',
      })
    ).toBe('presentation_production');
    expect(
      resolveEffectiveMissionType({
        missionType: 'development',
        matchedClassRuleId: 'class-code-change-refactoring-utterance',
      })
    ).toBe('refactoring');
  });

  it('promotes default types to reverse_spec / legacy_migration with spec-first precedence', () => {
    expect(
      resolveEffectiveMissionType({ missionType: 'development', utterance: 'レガシー移行したい' })
    ).toBe('legacy_migration');
    expect(
      resolveEffectiveMissionType({
        missionType: 'development',
        utterance: 'レガシー移行の前に既存コードから仕様を抽出して',
      })
    ).toBe('reverse_spec');
    expect(
      resolveEffectiveMissionType({
        missionType: 'development',
        matchedClassRuleId: 'class-code-change-legacy-migration-hint',
      })
    ).toBe('legacy_migration');
    expect(
      resolveEffectiveMissionType({
        missionType: 'reverse_spec',
        utterance: 'リファクタリングして',
      })
    ).toBe('reverse_spec');
    expect(
      resolveEffectiveMissionType({ missionType: 'development', utterance: 'add a db migration' })
    ).toBe('development');
  });

  it('rejects missing mission evidence without a directory', () => {
    expect(() => assertRefactoringEvidence('MSN-MISSING-REFACTOR', 'audit')).toThrow(
      /Mission directory not found|REFACTOR_EVIDENCE/
    );
  });
});
