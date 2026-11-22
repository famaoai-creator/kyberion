/** Stored-gate-only advancement for automated mission owners. */
import type { StoredGateEvaluationResult } from '@agent/core/mission/mission-process-planning';
import { createLogger } from '@agent/core/logger';

const logger = createLogger('mission-machine-gate');

export interface MachineMissionGatePorts {
  evaluateStored: (input: {
    missionId: string;
    gateId: string;
    humanConfirmed: false;
  }) => Promise<StoredGateEvaluationResult>;
  advance: (missionId: string, phase: string) => Promise<void>;
  markCompleted: (missionId: string, phase: string) => number;
  activate: (
    missionId: string,
    evaluation: NonNullable<StoredGateEvaluationResult['evaluation']>
  ) => Promise<boolean>;
  recordEvaluation?: (
    missionId: string,
    gateId: string,
    stored: StoredGateEvaluationResult
  ) => void;
}

export function parseMachineMissionGate(input: { missionId: string; gateId?: string }) {
  const missionId = input.missionId.trim().toUpperCase();
  const gateId = input.gateId;
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(missionId) ||
    !gateId ||
    !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(gateId)
  )
    throw new Error(
      'This gate-pass mode requires a mission ID and a stored gate ID; evidence files and paths are forbidden'
    );
  return { missionId, gateId };
}

/** There is intentionally no evidence-file resolver or override port. */
export async function runMachineOnlyMissionGate(
  input: { missionId: string; gateId?: string },
  ports: MachineMissionGatePorts
): Promise<{
  mission_id: string;
  gate_id: string;
  verdict: 'pass';
  completed_tasks: number;
  activated: boolean;
}> {
  const { missionId, gateId } = parseMachineMissionGate(input);
  const stored = await ports.evaluateStored({ missionId, gateId, humanConfirmed: false });
  if (!stored.found || !stored.evaluation) {
    logger.warn(
      `machine gate missing — no stored definition | next: define and satisfy the governed process gate | evidence: ${missionId}/${gateId}`
    );
    throw new Error(`Machine-only gate definition missing: ${missionId}/${gateId}`);
  }
  if (
    stored.evaluation.checks.some(
      (check) => check.kind === 'human_override' || check.kind === 'reviewer_approved'
    )
  ) {
    logger.warn(
      `machine gate requires attributed review — raw human confirmation is not machine evidence | next: use a governed approval-bound check or an explicit human review | evidence: ${missionId}/${gateId}`
    );
    throw new Error(
      `Machine-only gate cannot supply human or reviewer confirmation: ${missionId}/${gateId}`
    );
  }
  ports.recordEvaluation?.(missionId, gateId, stored);
  if (stored.evaluation.verdict !== 'pass') {
    logger.warn(
      `machine gate rejected — stored checks did not pass | next: satisfy the gate checks through their governed evidence | evidence: ${missionId}/${gateId}`
    );
    const failed = stored.evaluation.checks.filter((check) => !check.passed);
    const ciWaiting =
      gateId === 'TESTS_PASSED' &&
      failed.length > 0 &&
      failed.every((check) => check.kind === 'development_ci_verified') &&
      stored.evaluation.reasons.every((reason) => reason.startsWith('[DEVELOPMENT_CI_WAITING]')) &&
      stored.evaluation.reasons.length > 0;
    throw new Error(
      `${ciWaiting ? '[DEVELOPMENT_CI_WAITING] ' : ''}Machine-only gate checks failed: ${missionId}/${gateId}`
    );
  }
  const activated = await ports.activate(missionId, stored.evaluation);
  let completed = 0;
  if (stored.position === 'exit' && stored.phase) {
    await ports.advance(missionId, stored.phase);
    completed = ports.markCompleted(missionId, stored.phase);
  }
  logger.info(
    `machine gate passed — stored checks verified | next: continue the governed process | evidence: ${missionId}/${gateId}`
  );
  return {
    mission_id: missionId,
    gate_id: gateId,
    verdict: 'pass',
    completed_tasks: completed,
    activated,
  };
}
