import { beforeEach, describe, expect, it } from 'vitest';
import { withExecutionContext } from './authority.js';
import { pathResolver } from './path-resolver.js';
import { safeReadFile, safeRmSync } from './secure-io.js';

describe('mission-orchestration-journal', () => {
  beforeEach(() => {
    process.env.MISSION_ROLE = 'mission_controller';
  });

  it('tracks enqueued/completed events and resolves the next replay candidate', async () => {
    const missionId = 'MSN-JOURNAL-1';
    const missionPath = withExecutionContext('mission_controller', () =>
      pathResolver.missionDir(missionId, 'public')
    );
    withExecutionContext('mission_controller', () => {
      safeRmSync(`${missionPath}/coordination`, { recursive: true, force: true });
    });

    const {
      appendMissionOrchestrationJournalEntry,
      loadMissionOrchestrationJournal,
      loadMissionOrchestrationReplayPlan,
    } = await import('./mission-orchestration-journal.js');
    const { enqueueMissionOrchestrationEvent } = await import('./mission-orchestration-events.js');

    const first = enqueueMissionOrchestrationEvent({
      eventType: 'mission_issue_requested',
      missionId,
      requestedBy: 'tester',
      payload: { channel: 'slack', threadTs: '123' },
    });
    const second = enqueueMissionOrchestrationEvent({
      eventType: 'mission_team_prewarm_requested',
      missionId,
      requestedBy: 'tester',
      payload: { channel: 'slack', threadTs: '123' },
    });

    appendMissionOrchestrationJournalEntry({
      missionId,
      eventId: first.event_id,
      eventType: first.event_type,
      status: 'completed',
      payload: first.payload,
      requestedBy: first.requested_by,
      correlationId: first.correlation_id,
      causationId: first.causation_id,
    });

    const journal = loadMissionOrchestrationJournal(missionId);
    expect(journal.map((entry) => entry.status)).toEqual(['enqueued', 'enqueued', 'completed']);

    const replayPlan = loadMissionOrchestrationReplayPlan(missionId);
    expect(replayPlan.last_completed_event_id).toBe(first.event_id);
    expect(replayPlan.next_event?.event_id).toBe(second.event_id);
    expect(replayPlan.pending_event_ids).toContain(second.event_id);

    const journalPath = `${pathResolver.missionDir(missionId, 'public')}/coordination/orchestration-journal.jsonl`;
    const persisted = String(
      withExecutionContext(
        'mission_controller',
        () => safeReadFile(journalPath, { encoding: 'utf8' }) || ''
      )
    );
    expect(persisted).toContain(first.event_id);
    expect(persisted).toContain(second.event_id);
  });

  it('counts all pending events in the replay plan', async () => {
    const missionId = 'MSN-JOURNAL-2';
    const missionPath = withExecutionContext('mission_controller', () =>
      pathResolver.missionDir(missionId, 'public')
    );
    withExecutionContext('mission_controller', () => {
      safeRmSync(`${missionPath}/coordination`, { recursive: true, force: true });
    });

    const { appendMissionOrchestrationJournalEntry, loadMissionOrchestrationReplayPlan } =
      await import('./mission-orchestration-journal.js');
    const { enqueueMissionOrchestrationEvent } = await import('./mission-orchestration-events.js');

    const first = enqueueMissionOrchestrationEvent({
      eventType: 'mission_issue_requested',
      missionId,
      requestedBy: 'tester',
      payload: { channel: 'slack', threadTs: '123' },
    });
    const second = enqueueMissionOrchestrationEvent({
      eventType: 'mission_team_prewarm_requested',
      missionId,
      requestedBy: 'tester',
      payload: { channel: 'slack', threadTs: '123' },
    });
    const third = enqueueMissionOrchestrationEvent({
      eventType: 'mission_kickoff_requested',
      missionId,
      requestedBy: 'tester',
      payload: { channel: 'slack', threadTs: '123' },
    });

    appendMissionOrchestrationJournalEntry({
      missionId,
      eventId: first.event_id,
      eventType: first.event_type,
      status: 'completed',
      payload: first.payload,
      requestedBy: first.requested_by,
      correlationId: first.correlation_id,
      causationId: first.causation_id,
    });

    const replayPlan = loadMissionOrchestrationReplayPlan(missionId);
    expect(replayPlan.pending_event_ids).toEqual([second.event_id, third.event_id]);
    expect(replayPlan.replay_count).toBe(2);
    expect(replayPlan.last_completed_event_id).toBe(first.event_id);
    expect(replayPlan.next_event?.event_id).toBe(second.event_id);
  });
});
