export type PatchSeverity = 'low' | 'moderate' | 'high' | 'critical' | number;
export type PatchReachability = 'none' | 'transitive' | 'direct' | number;
export type PatchAttackSurface = 'local' | 'internal' | 'external' | number;
export type PatchSemverJump = 'patch' | 'minor' | 'major' | number;
export type PatchTestGap = 'covered' | 'partial' | 'thin' | number;
export type PatchRollbackDifficulty = 'easy' | 'moderate' | 'hard' | number;
export type PatchDecisionKind = 'auto_apply' | 'urgent_approval' | 'scheduled' | 'defer' | 'approval';

export interface PatchDecisionInput {
  severity: PatchSeverity;
  reachability: PatchReachability;
  attackSurface: PatchAttackSurface;
  semverJump: PatchSemverJump;
  testGap: PatchTestGap;
  rollbackDifficulty: PatchRollbackDifficulty;
}

export interface PatchDecisionScores {
  urgency: number;
  applyRisk: number;
}

export interface PatchDecisionResult extends PatchDecisionScores {
  decision: PatchDecisionKind;
}

const SEVERITY_SCORE: Record<Exclude<PatchSeverity, number>, number> = {
  low: 1,
  moderate: 2,
  high: 3,
  critical: 4,
};

const REACHABILITY_SCORE: Record<Exclude<PatchReachability, number>, number> = {
  none: 0,
  transitive: 1,
  direct: 2,
};

const ATTACK_SURFACE_SCORE: Record<Exclude<PatchAttackSurface, number>, number> = {
  local: 1,
  internal: 2,
  external: 3,
};

const SEMVER_JUMP_SCORE: Record<Exclude<PatchSemverJump, number>, number> = {
  patch: 1,
  minor: 2,
  major: 3,
};

const TEST_GAP_SCORE: Record<Exclude<PatchTestGap, number>, number> = {
  covered: 1,
  partial: 2,
  thin: 3,
};

const ROLLBACK_DIFFICULTY_SCORE: Record<Exclude<PatchRollbackDifficulty, number>, number> = {
  easy: 1,
  moderate: 2,
  hard: 3,
};

function clampLevel(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(3, Math.round(value)));
}

function scoreSeverity(severity: PatchSeverity): number {
  return typeof severity === 'number' ? clampLevel(severity) : SEVERITY_SCORE[severity];
}

function scoreReachability(reachability: PatchReachability): number {
  return typeof reachability === 'number' ? clampLevel(reachability) : REACHABILITY_SCORE[reachability];
}

function scoreAttackSurface(attackSurface: PatchAttackSurface): number {
  return typeof attackSurface === 'number' ? clampLevel(attackSurface) : ATTACK_SURFACE_SCORE[attackSurface];
}

function scoreSemverJump(semverJump: PatchSemverJump): number {
  return typeof semverJump === 'number' ? clampLevel(semverJump) : SEMVER_JUMP_SCORE[semverJump];
}

function scoreTestGap(testGap: PatchTestGap): number {
  return typeof testGap === 'number' ? clampLevel(testGap) : TEST_GAP_SCORE[testGap];
}

function scoreRollbackDifficulty(rollbackDifficulty: PatchRollbackDifficulty): number {
  return typeof rollbackDifficulty === 'number'
    ? clampLevel(rollbackDifficulty)
    : ROLLBACK_DIFFICULTY_SCORE[rollbackDifficulty];
}

function classifyUrgency(score: number): 'low' | 'medium' | 'high' {
  if (score >= 12) return 'high';
  if (score >= 4) return 'medium';
  return 'low';
}

function classifyApplyRisk(score: number): 'low' | 'medium' | 'high' {
  if (score >= 12) return 'high';
  if (score >= 4) return 'medium';
  return 'low';
}

export function computePatchDecisionScores(input: PatchDecisionInput): PatchDecisionScores {
  const urgency =
    scoreSeverity(input.severity) * scoreReachability(input.reachability) * scoreAttackSurface(input.attackSurface);
  const applyRisk =
    scoreSemverJump(input.semverJump) * scoreTestGap(input.testGap) * scoreRollbackDifficulty(input.rollbackDifficulty);
  return { urgency, applyRisk };
}

export function decidePatchAction(input: PatchDecisionInput): PatchDecisionResult {
  const scores = computePatchDecisionScores(input);
  const urgencyBand = classifyUrgency(scores.urgency);
  const applyRiskBand = classifyApplyRisk(scores.applyRisk);

  let decision: PatchDecisionKind;
  if (urgencyBand === 'high') {
    decision = applyRiskBand === 'low' ? 'auto_apply' : 'urgent_approval';
  } else if (urgencyBand === 'medium') {
    decision = applyRiskBand === 'low' ? 'scheduled' : 'approval';
  } else {
    decision = applyRiskBand === 'low' ? 'scheduled' : 'defer';
  }

  return { ...scores, decision };
}
