export type PatchDecision = 'auto_apply' | 'urgent_approval' | 'scheduled' | 'defer' | 'approval';

export interface PatchDecisionInput {
  severity: number;
  reachability: number;
  attackSurface: number;
  semverJump: number;
  testGap: number;
  rollbackDifficulty: number;
}

export interface PatchDecisionResult {
  decision: PatchDecision;
  urgencyScore: number;
  applyRiskScore: number;
  reason: string;
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(3, Math.trunc(value)));
}

export function computePatchDecisionScores(input: PatchDecisionInput): {
  urgencyScore: number;
  applyRiskScore: number;
} {
  const severity = clampScore(input.severity);
  const reachability = clampScore(input.reachability);
  const attackSurface = clampScore(input.attackSurface);
  const semverJump = clampScore(input.semverJump);
  const testGap = clampScore(input.testGap);
  const rollbackDifficulty = clampScore(input.rollbackDifficulty);

  return {
    urgencyScore: severity * 2 + reachability + attackSurface,
    applyRiskScore: semverJump + testGap + rollbackDifficulty,
  };
}

export function decidePatchAction(input: PatchDecisionInput): PatchDecisionResult {
  const { urgencyScore, applyRiskScore } = computePatchDecisionScores(input);

  if (urgencyScore >= 7 && applyRiskScore <= 2) {
    return {
      decision: 'auto_apply',
      urgencyScore,
      applyRiskScore,
      reason: 'High urgency and low application risk',
    };
  }

  if (urgencyScore >= 7 && applyRiskScore >= 4) {
    return {
      decision: 'urgent_approval',
      urgencyScore,
      applyRiskScore,
      reason: 'High urgency but elevated application risk',
    };
  }

  if (urgencyScore <= 3 && applyRiskScore >= 4) {
    return {
      decision: 'defer',
      urgencyScore,
      applyRiskScore,
      reason: 'Low urgency and high application risk',
    };
  }

  if (urgencyScore >= 4 && applyRiskScore <= 4) {
    return {
      decision: 'scheduled',
      urgencyScore,
      applyRiskScore,
      reason: 'Moderate urgency and manageable application risk',
    };
  }

  return {
    decision: 'approval',
    urgencyScore,
    applyRiskScore,
    reason: 'Default fail-safe approval path',
  };
}
