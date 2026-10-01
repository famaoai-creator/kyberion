import { afterEach, describe, expect, it, vi } from 'vitest';
import * as autonomousOpsGate from '@agent/core/governance/autonomous-ops-gate';
import * as decisionRouting from '@agent/core/governance/approval-decision-routing';
import * as missionState from './refactor/mission-state.js';
import * as maintenance from './refactor/mission-maintenance.js';
import { runAutoCheckpoint } from './auto_checkpoint.js';

describe('auto_checkpoint', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('creates checkpoints for active missions when gate allows', async () => {
    vi.spyOn(autonomousOpsGate, 'evaluateAutonomousOpsAction').mockReturnValue({
      actionId: 'auto_checkpoint',
      decision: 'auto',
      allowed: true,
      score: 1,
      maxScore: 6,
      policyVersion: 'test',
      executionMode: 'apply',
      reason: 'ok',
      axes: { scope: 0, reversibility: 0, sensitivity: 0, confidence: 1 },
      budgetCapTokens: 1000,
      shadow: false,
      escalations: [],
      highRiskPathMatches: [],
    });
    vi.spyOn(missionState, 'listActiveMissions').mockReturnValue([
      { missionId: 'mission-a', missionPath: '/tmp/mission-a' },
      { missionId: 'mission-b', missionPath: '/tmp/mission-b' },
    ]);
    vi.spyOn(missionState, 'loadState').mockImplementation(
      (missionId: string) =>
        ({
          mission_id: missionId,
          status: 'active',
          tier: 'confidential',
          git: { branch: 'main', start_commit: 'a', latest_commit: 'b', checkpoints: [] },
          tasks: [],
        }) as any
    );
    const checkpointSpy = vi.spyOn(maintenance, 'createCheckpoint').mockResolvedValue(undefined);

    const code = await runAutoCheckpoint();

    expect(code).toBe(0);
    expect(checkpointSpy).toHaveBeenCalledTimes(2);
    expect(checkpointSpy.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        explicitMissionId: 'mission-a',
        taskId: 'auto-checkpoint',
      })
    );
  });

  it('skips when the gate requires approval', async () => {
    vi.spyOn(autonomousOpsGate, 'evaluateAutonomousOpsAction').mockReturnValue({
      actionId: 'auto_checkpoint',
      decision: 'approve',
      allowed: false,
      score: 99,
      maxScore: 6,
      policyVersion: 'test',
      executionMode: 'apply',
      reason: 'approval required',
      axes: { scope: 3, reversibility: 3, sensitivity: 3, confidence: 3 },
      budgetCapTokens: 1000,
      shadow: false,
      escalations: [],
      highRiskPathMatches: [],
    });
    const checkpointSpy = vi.spyOn(maintenance, 'createCheckpoint');
    const routeSpy = vi.spyOn(decisionRouting, 'routeAutonomousDecision');
    vi.stubEnv('KYBERION_AUTONOMY_DECISION_ROUTING', '');
    const code = await runAutoCheckpoint();
    expect(code).toBe(0);
    expect(checkpointSpy).not.toHaveBeenCalled();
    // Without the opt-in the gated branch stays log-only.
    expect(routeSpy).not.toHaveBeenCalled();
  });

  it('parks a non-blocking decision card when routing is enabled', async () => {
    vi.stubEnv('KYBERION_AUTONOMY_DECISION_ROUTING', '1');
    vi.spyOn(autonomousOpsGate, 'evaluateAutonomousOpsAction').mockReturnValue({
      actionId: 'auto_checkpoint',
      decision: 'approve',
      allowed: false,
      score: 99,
      maxScore: 6,
      policyVersion: 'test',
      executionMode: 'apply',
      reason: 'approval required',
      axes: { scope: 3, reversibility: 3, sensitivity: 3, confidence: 3 },
      shadow: false,
      escalations: [],
      highRiskPathMatches: [],
    });
    const routeSpy = vi.spyOn(decisionRouting, 'routeAutonomousDecision').mockReturnValue({
      level: 'decide',
      timing: 'digest',
      proceed: false,
      parked: true,
      shadow: false,
      requestId: 'REQ-CHECKPOINT-1',
      notified: false,
    });
    const checkpointSpy = vi.spyOn(maintenance, 'createCheckpoint');

    expect(await runAutoCheckpoint()).toBe(0);
    expect(checkpointSpy).not.toHaveBeenCalled();
    expect(routeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        blocking: false,
        dedupeKey: 'scheduled',
        role: 'mission_controller',
      })
    );
  });
});
