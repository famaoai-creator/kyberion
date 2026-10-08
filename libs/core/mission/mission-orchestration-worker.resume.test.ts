import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from '../path-resolver.js';
import { withExecutionContext } from '../authority.js';

const mocks = vi.hoisted(() => {
  const safeExec = vi.fn();
  const spawnManagedProcess = vi.fn();
  const sendOpsAlert = vi.fn();
  return { safeExec, spawnManagedProcess, sendOpsAlert };
});
const temporaryMissionPaths: string[] = [];
const temporaryEventPaths: string[] = [];

vi.mock('../secure-io.js', async () => {
  const actual = await vi.importActual<typeof import('../secure-io.js')>('../secure-io.js');
  return {
    ...actual,
    safeExec: mocks.safeExec,
  };
});

vi.mock('../managed-process.js', () => ({
  spawnManagedProcess: mocks.spawnManagedProcess,
}));

vi.mock('../ops-alert.js', async () => {
  const actual = await vi.importActual<typeof import('../ops-alert.js')>('../ops-alert.js');
  return { ...actual, sendOpsAlert: mocks.sendOpsAlert };
});

/** Mission paths are owner-derived: a mission exists only once its state is recorded. */
async function seedMissionState(
  missionPath: string,
  missionId: string,
  tier: 'public' | 'confidential'
): Promise<void> {
  const { writeMissionStateAtPath } = await import('./mission-state-reader.js');
  writeMissionStateAtPath(`${missionPath}/mission-state.json`, {
    mission_id: missionId,
    tier,
    status: 'active',
    execution_mode: 'local',
    priority: 1,
    assigned_persona: 'worker',
    confidence_score: 1,
    git: { branch: `mission/${missionId}`, start_commit: 'a', latest_commit: 'a', checkpoints: [] },
    history: [],
  } as never);
}

describe('mission-orchestration-worker resume replay', () => {
  // No vi.resetModules(): the worker and the secure-io / tier-guard / authority
  // stack under it are imported once per file, here, and every later `await
  // import` hits the module cache. Re-importing that stack per test repeated its
  // module initialisation every test (operations-hygiene-runbook §5); importing
  // it up front also keeps that one-time load out of the first test's timeout.
  // Per-test state is the mocks and the fixture paths removed in afterEach.
  beforeAll(async () => {
    process.env.MISSION_ROLE = 'mission_controller';
    await import('./mission-orchestration-worker.js');
  }, 60_000);

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MISSION_ROLE = 'mission_controller';
  });

  afterEach(async () => {
    const { safeRmSync } = await import('../secure-io.js');
    for (const eventPath of temporaryEventPaths.splice(0)) {
      safeRmSync(eventPath, { force: true });
    }
    for (const missionPath of temporaryMissionPaths.splice(0)) {
      safeRmSync(missionPath, { recursive: true, force: true });
    }
  });

  it('replays the next event and resumes the mission controller command', async () => {
    const missionId = 'MSN-RESUME-REPLAY';
    const missionPath = withExecutionContext('mission_controller', () =>
      pathResolver.missionDir(missionId, 'public')
    );
    temporaryMissionPaths.push(missionPath);
    const coordinationPath = `${missionPath}/coordination`;

    const { safeRmSync, safeReadFile } = await import('../secure-io.js');
    safeRmSync(coordinationPath, { recursive: true, force: true });
    await seedMissionState(missionPath, missionId, 'public');

    const { enqueueMissionOrchestrationEvent } = await import('./mission-orchestration-events.js');
    const { appendMissionOrchestrationJournalEntry, loadMissionOrchestrationJournal } =
      await import('./mission-orchestration-journal.js');
    const { processMissionOrchestrationEventPath } =
      await import('./mission-orchestration-worker.js');

    const issue = enqueueMissionOrchestrationEvent({
      eventType: 'mission_issue_requested',
      missionId,
      requestedBy: 'tester',
      payload: { channel: 'slack', threadTs: '123' },
    });
    temporaryEventPaths.push(
      `${pathResolver.shared('coordination/orchestration/events')}/${issue.event_id}.json`
    );
    const followup = enqueueMissionOrchestrationEvent({
      eventType: 'mission_team_prewarm_requested',
      missionId,
      requestedBy: 'tester',
      payload: { channel: 'slack', threadTs: '123' },
    });
    temporaryEventPaths.push(
      `${pathResolver.shared('coordination/orchestration/events')}/${followup.event_id}.json`
    );

    appendMissionOrchestrationJournalEntry({
      missionId,
      eventId: issue.event_id,
      eventType: issue.event_type,
      status: 'completed',
      payload: issue.payload,
      requestedBy: issue.requested_by,
      correlationId: issue.correlation_id,
      causationId: issue.causation_id,
    });

    const controlEvent = enqueueMissionOrchestrationEvent({
      eventType: 'mission_control_requested',
      missionId,
      requestedBy: 'tester',
      payload: { operation: 'resume' },
    });
    temporaryEventPaths.push(
      `${pathResolver.shared('coordination/orchestration/events')}/${controlEvent.event_id}.json`
    );

    mocks.safeExec.mockReturnValue({ stdout: '', stderr: '', status: 0 });
    mocks.spawnManagedProcess.mockReturnValue(undefined);

    await processMissionOrchestrationEventPath(
      `${pathResolver.shared('coordination/orchestration/events')}/${controlEvent.event_id}.json`
    );
    await processMissionOrchestrationEventPath(
      `${pathResolver.shared('coordination/orchestration/events')}/${controlEvent.event_id}.json`
    );

    expect(mocks.spawnManagedProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        args: [
          'dist/scripts/run_mission_orchestration_event_worker.js',
          '--event',
          `${pathResolver.shared('coordination/orchestration/events')}/${followup.event_id}.json`,
        ],
      })
    );
    expect(mocks.safeExec).toHaveBeenCalledWith(
      'node',
      ['dist/scripts/mission_controller.js', 'resume', missionId],
      expect.objectContaining({ timeoutMs: expect.any(Number) })
    );
    const orchestrationWorkerCalls = mocks.spawnManagedProcess.mock.calls.filter(
      ([spec]) => spec?.args?.[0] === 'dist/scripts/run_mission_orchestration_event_worker.js'
    );
    expect(orchestrationWorkerCalls).toHaveLength(1);
    const resumeCommands = mocks.safeExec.mock.calls.filter(
      ([command, args]) =>
        command === 'node' &&
        args?.[0] === 'dist/scripts/mission_controller.js' &&
        args?.[1] === 'resume'
    );
    expect(resumeCommands).toHaveLength(1);

    const journal = loadMissionOrchestrationJournal(missionId);
    expect(journal.map((entry) => entry.status)).toEqual([
      'enqueued',
      'enqueued',
      'completed',
      'enqueued',
      'completed',
    ]);
    expect(
      String(
        safeReadFile(`${coordinationPath}/orchestration-journal.jsonl`, { encoding: 'utf8' }) || ''
      )
    ).toContain(controlEvent.event_id);
    safeRmSync(missionPath, { recursive: true, force: true });
  });

  it('passes an explicit resume contract to the dedicated goal-worker recovery handler', async () => {
    const { handleMissionWorkerRecoveryRequested } =
      await import('./mission-orchestration-lifecycle-handlers.js');
    const dispatchMissionNextTasks = vi.fn(async () => [
      { task_id: 'TASK-PAUSED', team_role: 'implementer', agent_id: 'agent-1' },
    ]);

    await handleMissionWorkerRecoveryRequested(
      {
        event_id: 'ME-RECOVERY-1',
        event_type: 'mission_worker_recovery_requested',
        mission_id: 'MSN-RECOVERY-HANDLER',
        requested_by: 'mission_controller',
        payload: { operation: 'resume_goal_driven' },
      },
      { dispatchMissionNextTasks } as never
    );

    expect(dispatchMissionNextTasks).toHaveBeenCalledWith('MSN-RECOVERY-HANDLER', 'ME-RECOVERY-1', {
      resumeGoalDriven: true,
    });
  });

  it('resolves worker evidence paths from an existing confidential mission root', async () => {
    const missionId = 'MSN-RECOVERY-CONFIDENTIAL';
    const missionPath = pathResolver.missionDir(missionId, 'confidential');
    const { safeMkdir, safeRmSync } = await import('../secure-io.js');
    safeRmSync(missionPath, { recursive: true, force: true });
    safeMkdir(missionPath, { recursive: true });
    await seedMissionState(missionPath, missionId, 'confidential');

    try {
      const { taskResultFilePath, taskClarificationFilePath } =
        await import('./mission-orchestration-worker-part-context.js');
      expect(taskResultFilePath(missionId, 'TASK-1')).toBe(
        `${missionPath}/evidence/task-result-TASK-1.json`
      );
      expect(taskClarificationFilePath(missionId, 'TASK-1')).toBe(
        `${missionPath}/evidence/task-clarification-TASK-1.json`
      );
    } finally {
      safeRmSync(missionPath, { recursive: true, force: true });
    }
  });

  it('keeps worker prompt and goal journal paths on the existing confidential root', async () => {
    const missionId = 'MSN-RECOVERY-CONFIDENTIAL-SCOPE';
    const missionPath = pathResolver.missionDir(missionId, 'confidential');
    const { safeMkdir, safeRmSync } = await import('../secure-io.js');
    safeRmSync(missionPath, { recursive: true, force: true });
    safeMkdir(missionPath, { recursive: true });
    await seedMissionState(missionPath, missionId, 'confidential');

    try {
      const { buildTaskExecutionPrompt } =
        await import('./mission-orchestration-worker-part-context.js');
      const { goalJournalPath } = await import('./mission-orchestration-worker-part-dispatch.js');
      const prompt = buildTaskExecutionPrompt({
        missionId,
        task: { task_id: 'TASK-1' } as never,
        teamRole: 'implementer',
        agentId: 'agent-1',
        missionContextPack: '',
        missionGoalLines: [],
        upstreamResultLines: [],
        teamSnapshotLines: [],
        reviewFindingsLines: [],
        artifactReviewLines: [],
      });

      expect(prompt).toContain(`Artifact root: ${missionPath}`);
      expect(goalJournalPath(missionId, 'TASK-1')).toBe(
        `${missionPath}/coordination/goal-journal-TASK-1.jsonl`
      );
    } finally {
      safeRmSync(missionPath, { recursive: true, force: true });
    }
  });

  it('sends a deduplicated operator alert when an orchestration event fails', async () => {
    const missionId = 'MSN-RESUME-FAILED';
    const missionPath = withExecutionContext('mission_controller', () =>
      pathResolver.missionDir(missionId, 'public')
    );
    temporaryMissionPaths.push(missionPath);
    const { safeRmSync } = await import('../secure-io.js');
    safeRmSync(`${missionPath}/coordination`, { recursive: true, force: true });
    await seedMissionState(missionPath, missionId, 'public');

    const { enqueueMissionOrchestrationEvent } = await import('./mission-orchestration-events.js');
    const { loadMissionOrchestrationJournal } = await import('./mission-orchestration-journal.js');
    const { processMissionOrchestrationEventPath } =
      await import('./mission-orchestration-worker.js');
    const event = enqueueMissionOrchestrationEvent({
      eventType: 'mission_control_requested',
      missionId,
      requestedBy: 'tester',
      payload: { operation: 'unsupported' },
    });
    const eventPath = `${pathResolver.shared('coordination/orchestration/events')}/${event.event_id}.json`;
    temporaryEventPaths.push(eventPath);

    await expect(processMissionOrchestrationEventPath(eventPath)).rejects.toThrow(
      'Unsupported mission control operation'
    );

    expect(loadMissionOrchestrationJournal(missionId).at(-1)?.status).toBe('failed');
    expect(mocks.sendOpsAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'mission_orchestration',
        context: expect.objectContaining({ mission_id: missionId, event_id: event.event_id }),
        dedupe_key: `mission-orchestration:event-failed:${event.event_id}`,
      })
    );
    expect(JSON.stringify(mocks.sendOpsAlert.mock.calls)).not.toContain(
      'Unsupported mission control operation'
    );
  });
});
