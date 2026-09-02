import { beforeEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { withExecutionContext } from './authority.js';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from './secure-io.js';

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

  it('records operation kind/attempt/outcome and reduces records without I/O', async () => {
    const { appendMissionOrchestrationJournalEntry, reduceMissionState } =
      await import('./mission-orchestration-journal.js');

    const missionId = `MSN-JOURNAL-OP-${process.pid}`;
    const missionPath = withExecutionContext('mission_controller', () =>
      pathResolver.missionDir(missionId, 'public')
    );
    withExecutionContext('mission_controller', () => {
      safeRmSync(`${missionPath}/coordination`, { recursive: true, force: true });
    });

    const enqueued = appendMissionOrchestrationJournalEntry({
      missionId,
      eventId: 'EV-OP-1',
      eventType: 'mission_followup_requested',
      status: 'enqueued',
      payload: { task: 'checkpoint' },
      operation: { kind: 'checkpoint', attempt: 2 },
    });
    const suspended = appendMissionOrchestrationJournalEntry({
      missionId,
      eventId: 'EV-OP-1',
      eventType: 'mission_followup_requested',
      status: 'failed',
      payload: { task: 'checkpoint' },
      operation: { kind: 'checkpoint', attempt: 2 },
      outcome: { status: 'suspended', reason: 'worker_stopped' },
    });

    expect(enqueued.operation).toEqual({ id: 'EV-OP-1', kind: 'checkpoint', attempt: 2 });
    expect(suspended.outcome).toEqual({ status: 'suspended', reason: 'worker_stopped' });
    const reduced = reduceMissionState([enqueued, suspended]);
    expect(reduced.pending_operation_ids).toEqual(['EV-OP-1']);
    expect(reduced.terminal_failure).toBeNull();
    expect(reduced.operations['EV-OP-1'].outcome.status).toBe('suspended');

    const retried = appendMissionOrchestrationJournalEntry({
      missionId,
      eventId: 'EV-OP-1',
      eventType: 'mission_followup_requested',
      status: 'enqueued',
      payload: { task: 'checkpoint' },
    });
    expect(retried.operation.attempt).toBe(3);
  });

  it('provisions, writes, and verifies an artifact; mismatch is fail-closed', async () => {
    const { provisionMissionEntry, verifyProvisionedEntry, writeProvisionedEntry } =
      await import('./mission-orchestration-journal.js');
    const dir = pathResolver.shared(`tmp/pi-provisioned-entry-${process.pid}`);
    const filePath = `${dir}/artifact.json`;
    safeMkdir(dir, { recursive: true });
    safeRmSync(filePath, { force: true });

    const provisioned = provisionMissionEntry({ artifact: 'worker-output', version: 1 });
    const persisted = writeProvisionedEntry(filePath, provisioned);
    expect(persisted.id).toBe(provisioned.id);
    expect(persisted.content_hash).toBe(provisioned.content_hash);
    expect(() =>
      verifyProvisionedEntry(provisioned, {
        ...persisted,
        content: { artifact: 'tampered', version: 1 },
      })
    ).toThrow('MISSION_LOG_CORRUPT:provisioned_entry_mismatch');

    safeRmSync(dir, { recursive: true, force: true });
  });

  it('rejects unreadable journal lines and regressing operation attempts', async () => {
    const {
      appendMissionOrchestrationJournalEntry,
      loadMissionOrchestrationJournal,
      reduceMissionState,
    } = await import('./mission-orchestration-journal.js');
    const missionId = `MSN-JOURNAL-CORRUPT-${process.pid}`;
    const missionPath = withExecutionContext('mission_controller', () =>
      pathResolver.missionDir(missionId, 'public')
    );
    withExecutionContext('mission_controller', () => {
      safeRmSync(`${missionPath}/coordination`, { recursive: true, force: true });
      safeMkdir(`${missionPath}/coordination`, { recursive: true });
      safeWriteFile(`${missionPath}/coordination/orchestration-journal.jsonl`, '{not-json}\n');
    });
    expect(() => loadMissionOrchestrationJournal(missionId)).toThrow(
      'MISSION_LOG_CORRUPT:journal_entry_unreadable:1'
    );
    withExecutionContext('mission_controller', () =>
      safeRmSync(`${missionPath}/coordination`, { recursive: true, force: true })
    );
    withExecutionContext('mission_controller', () => {
      safeMkdir(`${missionPath}/coordination`, { recursive: true });
      safeWriteFile(`${missionPath}/coordination/orchestration-journal.jsonl`, '[]\n');
    });
    expect(() => loadMissionOrchestrationJournal(missionId)).toThrow(
      'MISSION_LOG_CORRUPT:journal_entry_unreadable:1'
    );
    withExecutionContext('mission_controller', () =>
      safeRmSync(`${missionPath}/coordination`, { recursive: true, force: true })
    );

    const first = appendMissionOrchestrationJournalEntry({
      missionId,
      eventId: 'EV-CORRUPT-1',
      eventType: 'mission_followup_requested',
      status: 'enqueued',
      payload: { attempt: 2 },
      operation: { id: 'OP-CORRUPT', kind: 'run', attempt: 2 },
    });
    const older = {
      ...first,
      event_id: 'EV-CORRUPT-OLDER',
      operation: { id: 'OP-CORRUPT', kind: 'run' as const, attempt: 1 },
    };
    expect(() => reduceMissionState([first, older])).toThrow(
      'MISSION_LOG_CORRUPT:operation_attempt_regression:OP-CORRUPT'
    );
  });

  it('records provision intent before a native JSON write and verifies it after the write', async () => {
    const { loadProvisionedEntryRecords, provisionMissionEntry, writeProvisionedJson } =
      await import('./mission-orchestration-journal.js');
    const missionId = `MSN-JOURNAL-PROVISION-${process.pid}`;
    const missionPath = withExecutionContext('mission_controller', () =>
      pathResolver.missionDir(missionId, 'public')
    );
    const dir = pathResolver.shared(`tmp/pi-provisioned-json-${process.pid}`);
    const filePath = `${dir}/NEXT_TASKS.json`;
    withExecutionContext('mission_controller', () => {
      safeRmSync(`${missionPath}/coordination`, { recursive: true, force: true });
      safeRmSync(dir, { recursive: true, force: true });
      safeMkdir(dir, { recursive: true });
    });
    const provisioned = provisionMissionEntry([{ task_id: 'TASK-1', status: 'planned' }]);
    const content = writeProvisionedJson({
      missionId,
      filePath,
      targetPath: 'NEXT_TASKS.json',
      provisioned,
    });
    expect(content).toEqual([{ task_id: 'TASK-1', status: 'planned' }]);
    const records = loadProvisionedEntryRecords(missionId);
    expect(records.map((record) => record.phase)).toEqual(['provisioned', 'verified']);
    expect(records[0]).toMatchObject({
      entry_id: provisioned.id,
      content_hash: provisioned.content_hash,
      target_path: 'NEXT_TASKS.json',
    });
    expect(String(safeReadFile(filePath, { encoding: 'utf8' }))).not.toContain('provisioned');
    withExecutionContext('mission_controller', () => {
      safeRmSync(`${missionPath}/coordination`, { recursive: true, force: true });
      safeRmSync(dir, { recursive: true, force: true });
    });
  });

  it('records provision intent for native text writes without wrapping the file', async () => {
    const { loadProvisionedEntryRecords, provisionMissionEntry, writeProvisionedText } =
      await import('./mission-orchestration-journal.js');
    const missionId = `MSN-JOURNAL-TEXT-${process.pid}`;
    const missionPath = withExecutionContext('mission_controller', () =>
      pathResolver.missionDir(missionId, 'public')
    );
    const dir = pathResolver.shared(`tmp/pi-provisioned-text-${process.pid}`);
    const filePath = `${dir}/PLAN.md`;
    withExecutionContext('mission_controller', () => {
      safeRmSync(`${missionPath}/coordination`, { recursive: true, force: true });
      safeRmSync(dir, { recursive: true, force: true });
      safeMkdir(dir, { recursive: true });
    });

    const provisioned = provisionMissionEntry('# PLAN\n\n## Objective\nKeep native text.\n');
    const content = writeProvisionedText({
      missionId,
      filePath,
      targetPath: 'PLAN.md',
      provisioned,
    });

    expect(content).toBe(provisioned.content);
    expect(String(safeReadFile(filePath, { encoding: 'utf8' }))).toBe(provisioned.content);
    expect(loadProvisionedEntryRecords(missionId).map((record) => record.phase)).toEqual([
      'provisioned',
      'verified',
    ]);
    expect(loadProvisionedEntryRecords(missionId)[0]).toMatchObject({
      entry_id: provisioned.id,
      content_hash: provisioned.content_hash,
      target_path: 'PLAN.md',
    });

    withExecutionContext('mission_controller', () => {
      safeRmSync(`${missionPath}/coordination`, { recursive: true, force: true });
      safeRmSync(dir, { recursive: true, force: true });
    });
  });

  it('detects unverified provision receipts and rejects orphaned verification', async () => {
    const { findUnverifiedProvisionedEntries } = await import('./mission-orchestration-journal.js');
    const record = {
      ts: new Date().toISOString(),
      entry_id: 'PE-UNVERIFIED',
      content_hash: 'hash',
      target_path: 'PLAN.md',
      phase: 'provisioned' as const,
    };

    expect(findUnverifiedProvisionedEntries([record])).toEqual([record]);
    expect(
      findUnverifiedProvisionedEntries([record, { ...record, phase: 'verified' as const }])
    ).toEqual([]);
    expect(() =>
      findUnverifiedProvisionedEntries([{ ...record, phase: 'verified' as const }])
    ).toThrow('MISSION_LOG_CORRUPT:verified_entry_without_provision:PE-UNVERIFIED');
  });

  it('blocks orchestration replay while a provisioned receipt is unverified', async () => {
    const missionId = `MSN-JOURNAL-RECOVERY-${process.pid}`;
    const missionPath = withExecutionContext('mission_controller', () =>
      pathResolver.missionDir(missionId, 'public')
    );
    withExecutionContext('mission_controller', () => {
      safeRmSync(`${missionPath}/coordination`, { recursive: true, force: true });
    });

    const {
      appendProvisionedEntryRecord,
      loadMissionOrchestrationReplayPlan,
      provisionMissionEntry,
    } = await import('./mission-orchestration-journal.js');
    const { enqueueMissionOrchestrationEvent } = await import('./mission-orchestration-events.js');
    const event = enqueueMissionOrchestrationEvent({
      eventType: 'mission_issue_requested',
      missionId,
      requestedBy: 'tester',
      payload: { channel: 'test', threadTs: 'recovery' },
    });
    appendProvisionedEntryRecord({
      missionId,
      entry: provisionMissionEntry({ goal: 'recover without duplicate execution' }),
      targetPath: 'PLAN.md',
      phase: 'provisioned',
    });

    const plan = loadMissionOrchestrationReplayPlan(missionId);
    expect(plan.pending_event_ids).toContain(event.event_id);
    expect(plan.next_event).toBeNull();
    expect(plan.recovery_required).toBe(true);
    expect(plan.recovery_reason).toBe('unverified_provisioned_entries');
    expect(plan.unverified_provisioned_entries).toHaveLength(1);

    withExecutionContext('mission_controller', () => {
      safeRmSync(`${missionPath}/coordination`, { recursive: true, force: true });
    });
  });

  it('rejects provisioned artifact paths outside the repository root', async () => {
    const { provisionMissionEntry, writeProvisionedEntry } =
      await import('./mission-orchestration-journal.js');
    const outside = path.join(pathResolver.rootDir(), '..', 'mission-journal-outside.json');
    expect(() =>
      writeProvisionedEntry(
        outside,
        provisionMissionEntry({ secret: 'must stay in the repository' })
      )
    ).toThrow('[RESOURCE_PATH_SCOPE]');
  });

  it('blocks replay when a verified artifact is missing or has been changed', async () => {
    const missionId = `MSN-JOURNAL-TARGET-${process.pid}`;
    const missionPath = withExecutionContext('mission_controller', () =>
      pathResolver.missionDir(missionId, 'public')
    );
    const artifactPath = `${missionPath}/PLAN.md`;
    withExecutionContext('mission_controller', () => {
      safeRmSync(`${missionPath}/coordination`, { recursive: true, force: true });
      safeRmSync(artifactPath, { force: true });
    });

    const {
      findMissingProvisionedEntries,
      loadMissionOrchestrationReplayPlan,
      loadProvisionedEntryRecords,
      provisionMissionEntry,
      writeProvisionedText,
    } = await import('./mission-orchestration-journal.js');
    writeProvisionedText({
      missionId,
      filePath: artifactPath,
      targetPath: 'PLAN.md',
      missionPathHint: missionPath,
      provisioned: provisionMissionEntry('# plan\n'),
    });

    withExecutionContext('mission_controller', () => safeRmSync(artifactPath, { force: true }));
    const missingPlan = loadMissionOrchestrationReplayPlan(missionId);
    expect(missingPlan.recovery_required).toBe(true);
    expect(missingPlan.recovery_reason).toBe('missing_provisioned_entries');
    expect(missingPlan.missing_provisioned_entries).toHaveLength(1);
    expect(missingPlan.next_event).toBeNull();

    writeProvisionedText({
      missionId,
      filePath: artifactPath,
      targetPath: 'PLAN.md',
      missionPathHint: missionPath,
      provisioned: provisionMissionEntry('# plan\n'),
    });
    withExecutionContext('mission_controller', () => safeWriteFile(artifactPath, '# changed\n'));
    const records = loadProvisionedEntryRecords(missionId);
    expect(() => findMissingProvisionedEntries(missionId, records)).toThrow(
      'MISSION_LOG_CORRUPT:provisioned_entry_mismatch'
    );

    writeProvisionedText({
      missionId,
      filePath: artifactPath,
      targetPath: 'PLAN.md',
      missionPathHint: missionPath,
      provisioned: provisionMissionEntry('# repaired\n'),
    });
    expect(
      findMissingProvisionedEntries(missionId, loadProvisionedEntryRecords(missionId))
    ).toEqual([]);
    withExecutionContext('mission_controller', () => {
      safeRmSync(`${missionPath}/coordination`, { recursive: true, force: true });
      safeRmSync(missionPath, { recursive: true, force: true });
    });
  });

  it('rejects malformed provisioned-entry records through the schema boundary', async () => {
    const { loadProvisionedEntryRecords } = await import('./mission-orchestration-journal.js');
    const missionId = `MSN-JOURNAL-RECORD-SCHEMA-${process.pid}`;
    const missionPath = withExecutionContext('mission_controller', () =>
      pathResolver.missionDir(missionId, 'public')
    );
    const recordPath = `${missionPath}/coordination/provisioned-entries.jsonl`;
    withExecutionContext('mission_controller', () => {
      safeRmSync(`${missionPath}/coordination`, { recursive: true, force: true });
      safeMkdir(`${missionPath}/coordination`, { recursive: true });
      safeWriteFile(recordPath, `${JSON.stringify({ entry_id: 'missing-fields' })}\n`);
    });

    expect(() => loadProvisionedEntryRecords(missionId)).toThrow(
      'MISSION_LOG_CORRUPT:provisioned_entry_record:1'
    );
    withExecutionContext('mission_controller', () =>
      safeRmSync(`${missionPath}/coordination`, { recursive: true, force: true })
    );
  });
});
