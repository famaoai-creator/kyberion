import fs from 'node:fs';
import path from 'node:path';
import AjvModule from 'ajv';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from '../path-resolver.js';
import { compileSchemaFromPath } from '../schema-loader.js';

const mocks = vi.hoisted(() => {
  const spawnManagedProcess = vi.fn();
  return { spawnManagedProcess };
});

const Ajv = (AjvModule as any).default ?? AjvModule;

vi.mock('../managed-process.js', () => ({
  spawnManagedProcess: mocks.spawnManagedProcess,
}));

const QUEUE_MISSION_DIR = pathResolver.missionDir('MSN-QUEUE', 'public');

describe('mission-orchestration-events', () => {
  // Payloads land beside the existing mission (owner-derived), so seed it.
  beforeAll(async () => {
    process.env.MISSION_ROLE = 'mission_controller';
    const { writeMissionStateAtPath } = await import('./mission-state-reader.js');
    writeMissionStateAtPath(path.join(QUEUE_MISSION_DIR, 'mission-state.json'), {
      mission_id: 'MSN-QUEUE',
      tier: 'public',
      status: 'active',
      execution_mode: 'local',
      priority: 1,
      assigned_persona: 'worker',
      confidence_score: 1,
      git: { branch: 'mission/MSN-QUEUE', start_commit: 'a', latest_commit: 'a', checkpoints: [] },
      history: [],
    } as never);
  });

  afterAll(async () => {
    const { safeRmSync } = await import('../secure-io.js');
    safeRmSync(QUEUE_MISSION_DIR, { recursive: true, force: true });
  });

  beforeEach(() => {
    // No vi.resetModules(): the module under test and the secure-io / tier-guard /
    // authority stack under it are imported once per file (the first `await
    // import`; later ones hit the module cache). Re-importing that stack per test
    // repeated its module initialisation every test (operations-hygiene-runbook §5).
    // Per-test state is the mocks; every event is written to its own path.
    vi.clearAllMocks();
    process.env.MISSION_ROLE = 'mission_controller';
  });

  it('queues a mission orchestration event artifact', async () => {
    const { enqueueMissionOrchestrationEvent, getMissionOrchestrationEventPath } =
      await import('./mission-orchestration-events.js');
    const { safeExistsSync, safeReadFile } = await import('../secure-io.js');

    const event = enqueueMissionOrchestrationEvent({
      eventType: 'mission_issue_requested',
      missionId: 'MSN-QUEUE',
      requestedBy: 'test',
      payload: { channel: 'slack', threadTs: '123', sourceText: 'must stay mission-local' },
    });

    const eventPath = getMissionOrchestrationEventPath(event.event_id);
    expect(safeExistsSync(eventPath)).toBe(true);
    const stored = JSON.parse(safeReadFile(eventPath, { encoding: 'utf8' }) as string);
    expect(stored.event_type).toBe('mission_issue_requested');
    expect(stored.mission_id).toBe('MSN-QUEUE');
    expect(stored.payload).toEqual({});
    expect(stored.payload_ref).toContain('/coordination/orchestration/payloads/');
    expect(JSON.stringify(stored)).not.toContain('must stay mission-local');
    const loaded = (
      await import('./mission-orchestration-events.js')
    ).loadMissionOrchestrationEvent<typeof event.payload>(eventPath);
    expect(loaded.payload.sourceText).toBe('must stay mission-local');
  });

  it('starts a detached worker for an orchestration event', async () => {
    const { enqueueMissionOrchestrationEvent, startMissionOrchestrationWorker } =
      await import('./mission-orchestration-events.js');

    const event = enqueueMissionOrchestrationEvent({
      eventType: 'mission_issue_requested',
      missionId: 'MSN-QUEUE',
      requestedBy: 'test',
      payload: { channel: 'slack', threadTs: '123' },
    });

    const eventPath = startMissionOrchestrationWorker(event);
    expect(eventPath).toContain(`${event.event_id}.json`);
    expect(mocks.spawnManagedProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        command: process.execPath,
        args: ['dist/scripts/run_mission_orchestration_event_worker.js', '--event', eventPath],
      })
    );
  });

  it('emits mission orchestration events that satisfy the schema', async () => {
    const { enqueueMissionOrchestrationEvent } = await import('./mission-orchestration-events.js');
    const { safeReadFile } = await import('../secure-io.js');

    const event = enqueueMissionOrchestrationEvent({
      eventType: 'mission_issue_requested',
      missionId: 'MSN-QUEUE',
      requestedBy: 'test',
      payload: { channel: 'slack', threadTs: '123' },
    });
    const eventPath = `${pathResolver.shared('coordination/orchestration/events')}/${event.event_id}.json`;
    const stored = JSON.parse(safeReadFile(eventPath, { encoding: 'utf8' }) as string);

    const ajv = new Ajv({ allErrors: true });
    const validate = compileSchemaFromPath(
      ajv,
      path.join(
        pathResolver.rootDir(),
        'knowledge/product/schemas/mission-orchestration-event.schema.json'
      )
    );
    const valid = validate(stored);
    expect(valid, JSON.stringify(validate.errors || [])).toBe(true);
  });

  it('rejects an orchestration scope that invents a different tenant lineage', async () => {
    const { enqueueMissionOrchestrationEvent } = await import('./mission-orchestration-events.js');

    expect(() =>
      enqueueMissionOrchestrationEvent({
        eventType: 'mission_issue_requested',
        missionId: 'MSN-QUEUE',
        requestedBy: 'test',
        scope: { tier: 'confidential', tenant_slug: 'other-tenant' },
        payload: { channel: 'slack' },
      })
    ).toThrow(/EVENT_SCOPE_LINEAGE_CONFLICT/);
  });

  it('rejects a persisted orchestration event with an unknown event type', async () => {
    const { loadMissionOrchestrationEvent } = await import('./mission-orchestration-events.js');
    const { safeUnlinkSync, safeWriteFile } = await import('../secure-io.js');
    const eventPath = pathResolver.sharedTmp(`invalid-orchestration-${process.pid}.json`);
    safeWriteFile(
      eventPath,
      JSON.stringify({
        event_id: 'ME-INVALID',
        event_type: 'forged_event',
        mission_id: 'MSN-QUEUE',
        requested_by: 'test',
        payload: {},
      })
    );
    try {
      expect(() => loadMissionOrchestrationEvent(eventPath)).toThrow(
        'MISSION_ORCHESTRATION_EVENT_INVALID'
      );
    } finally {
      safeUnlinkSync(eventPath);
    }
  });

  it('rejects an orchestration payload envelope with unknown fields', async () => {
    const { enqueueMissionOrchestrationEvent, loadMissionOrchestrationEvent } =
      await import('./mission-orchestration-events.js');
    const { safeReadFile, safeUnlinkSync, safeWriteFile } = await import('../secure-io.js');
    const event = enqueueMissionOrchestrationEvent({
      eventType: 'mission_issue_requested',
      missionId: 'MSN-QUEUE',
      requestedBy: 'test',
      payload: { sourceText: 'payload schema test' },
    });
    const eventPath = `${pathResolver.shared('coordination/orchestration/events')}/${event.event_id}.json`;
    const payloadPath = pathResolver.rootResolve(event.payload_ref!);
    const payload = JSON.parse(safeReadFile(payloadPath, { encoding: 'utf8' }) as string);
    safeWriteFile(payloadPath, JSON.stringify({ ...payload, unexpected: true }));
    try {
      expect(() => loadMissionOrchestrationEvent(eventPath)).toThrow(
        '[MISSION_ORCHESTRATION_EVENT_INVALID]'
      );
    } finally {
      safeUnlinkSync(payloadPath);
      safeUnlinkSync(eventPath);
    }
  });

  it('rejects an orchestration payload envelope bound to another event', async () => {
    const { enqueueMissionOrchestrationEvent, loadMissionOrchestrationEvent } =
      await import('./mission-orchestration-events.js');
    const { safeReadFile, safeUnlinkSync, safeWriteFile } = await import('../secure-io.js');
    const event = enqueueMissionOrchestrationEvent({
      eventType: 'mission_issue_requested',
      missionId: 'MSN-QUEUE',
      requestedBy: 'test',
      payload: { sourceText: 'payload binding test' },
    });
    const eventPath = `${pathResolver.shared('coordination/orchestration/events')}/${event.event_id}.json`;
    const payloadPath = pathResolver.rootResolve(event.payload_ref!);
    const payload = JSON.parse(safeReadFile(payloadPath, { encoding: 'utf8' }) as string);
    safeWriteFile(payloadPath, JSON.stringify({ ...payload, event_id: 'ME-OTHER' }));
    try {
      expect(() => loadMissionOrchestrationEvent(eventPath)).toThrow(
        '[MISSION_ORCHESTRATION_PAYLOAD_SCOPE_MISMATCH]'
      );
    } finally {
      safeUnlinkSync(payloadPath);
      safeUnlinkSync(eventPath);
    }
  });

  it('rejects an orchestration event loaded through a symlink', async () => {
    const { loadMissionOrchestrationEvent } = await import('./mission-orchestration-events.js');
    const { safeUnlinkSync, safeWriteFile } = await import('../secure-io.js');
    const targetPath = pathResolver.sharedTmp(`valid-orchestration-${process.pid}.json`);
    const linkedPath = pathResolver.sharedTmp(`linked-orchestration-${process.pid}.json`);
    safeWriteFile(
      targetPath,
      JSON.stringify({
        event_id: 'ME-SYMLINK',
        event_type: 'mission_issue_requested',
        mission_id: 'MSN-QUEUE',
        requested_by: 'test',
        payload: {},
      })
    );
    fs.symlinkSync(targetPath, linkedPath, 'file');
    try {
      expect(() => loadMissionOrchestrationEvent(linkedPath)).toThrow('[RESOURCE_PATH_SYMLINK]');
    } finally {
      fs.unlinkSync(linkedPath);
      safeUnlinkSync(targetPath);
    }
  });

  it('rejects a mission id before resolving a tenant payload path', async () => {
    const { enqueueMissionOrchestrationEvent } = await import('./mission-orchestration-events.js');
    expect(() =>
      enqueueMissionOrchestrationEvent({
        eventType: 'mission_issue_requested',
        missionId: '../MSN-ESCAPE',
        requestedBy: 'test',
        payload: {},
        scope: { tier: 'confidential', tenant_slug: 'client-a' },
      })
    ).toThrow(/invalid mission id/i);
  });

  it('rejects an event id that escapes the shared event directory', async () => {
    const { getMissionOrchestrationEventPath } = await import('./mission-orchestration-events.js');
    expect(() => getMissionOrchestrationEventPath('../outside')).toThrow(/invalid event id/);
  });

  it('accepts all runtime orchestration event types', async () => {
    const { enqueueMissionOrchestrationEvent } = await import('./mission-orchestration-events.js');
    expect(
      enqueueMissionOrchestrationEvent({
        eventType: 'mission_distillation_requested',
        missionId: 'MSN-QUEUE',
        requestedBy: 'test',
        payload: {},
      }).event_type
    ).toBe('mission_distillation_requested');
    expect(
      enqueueMissionOrchestrationEvent({
        eventType: 'mission_completion_requested',
        missionId: 'MSN-QUEUE',
        requestedBy: 'test',
        payload: {},
      }).event_type
    ).toBe('mission_completion_requested');
  });
});
