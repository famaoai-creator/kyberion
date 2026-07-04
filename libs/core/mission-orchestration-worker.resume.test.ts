import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { withExecutionContext } from './authority.js';

const mocks = vi.hoisted(() => {
  const safeExec = vi.fn();
  const spawnManagedProcess = vi.fn();
  return { safeExec, spawnManagedProcess };
});

vi.mock('./secure-io.js', async () => {
  const actual = await vi.importActual<typeof import('./secure-io.js')>('./secure-io.js');
  return {
    ...actual,
    safeExec: mocks.safeExec,
  };
});

vi.mock('./managed-process.js', () => ({
  spawnManagedProcess: mocks.spawnManagedProcess,
}));

describe('mission-orchestration-worker resume replay', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env.MISSION_ROLE = 'mission_controller';
  });

  it('replays the next event and resumes the mission controller command', async () => {
    const missionId = 'MSN-RESUME-REPLAY';
    const missionPath = withExecutionContext('mission_controller', () =>
      pathResolver.missionDir(missionId, 'public')
    );
    const coordinationPath = `${missionPath}/coordination`;

    const { safeRmSync, safeReadFile } = await import('./secure-io.js');
    safeRmSync(coordinationPath, { recursive: true, force: true });

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
    const followup = enqueueMissionOrchestrationEvent({
      eventType: 'mission_team_prewarm_requested',
      missionId,
      requestedBy: 'tester',
      payload: { channel: 'slack', threadTs: '123' },
    });

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

    mocks.safeExec.mockReturnValue({ stdout: '', stderr: '', status: 0 });
    mocks.spawnManagedProcess.mockReturnValue(undefined);

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
  });
});
