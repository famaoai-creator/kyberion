import path from 'node:path';
import AjvModule from 'ajv';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { compileSchemaFromPath } from './schema-loader.js';

const mocks = vi.hoisted(() => {
  const spawnManagedProcess = vi.fn();
  return { spawnManagedProcess };
});

const Ajv = (AjvModule as any).default ?? AjvModule;

vi.mock('./managed-process.js', () => ({
  spawnManagedProcess: mocks.spawnManagedProcess,
}));

describe('mission-orchestration-events', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env.MISSION_ROLE = 'mission_controller';
  });

  it('queues a mission orchestration event artifact', async () => {
    const { enqueueMissionOrchestrationEvent, getMissionOrchestrationEventPath } = await import('./mission-orchestration-events.js');
    const { safeExistsSync, safeReadFile } = await import('./secure-io.js');

    const event = enqueueMissionOrchestrationEvent({
      eventType: 'mission_issue_requested',
      missionId: 'MSN-QUEUE',
      requestedBy: 'test',
      payload: { channel: 'slack', threadTs: '123' },
    });

    const eventPath = getMissionOrchestrationEventPath(event.event_id);
    expect(safeExistsSync(eventPath)).toBe(true);
    const stored = JSON.parse(safeReadFile(eventPath, { encoding: 'utf8' }) as string);
    expect(stored.event_type).toBe('mission_issue_requested');
    expect(stored.mission_id).toBe('MSN-QUEUE');
  });

  it('starts a detached worker for an orchestration event', async () => {
    const { enqueueMissionOrchestrationEvent, startMissionOrchestrationWorker } = await import('./mission-orchestration-events.js');

    const event = enqueueMissionOrchestrationEvent({
      eventType: 'mission_issue_requested',
      missionId: 'MSN-QUEUE',
      requestedBy: 'test',
      payload: { channel: 'slack', threadTs: '123' },
    });

    const eventPath = startMissionOrchestrationWorker(event);
    expect(eventPath).toContain(`${event.event_id}.json`);
    expect(mocks.spawnManagedProcess).toHaveBeenCalledWith(expect.objectContaining({
      command: 'node',
      args: ['dist/scripts/run_mission_orchestration_event_worker.js', '--event', eventPath],
    }));
  });

  it('emits mission orchestration events that satisfy the schema', async () => {
    const { enqueueMissionOrchestrationEvent } = await import('./mission-orchestration-events.js');
    const { safeReadFile } = await import('./secure-io.js');

    const event = enqueueMissionOrchestrationEvent({
      eventType: 'mission_issue_requested',
      missionId: 'MSN-QUEUE',
      requestedBy: 'test',
      payload: { channel: 'slack', threadTs: '123' },
    });
    const eventPath = `${pathResolver.shared('coordination/orchestration/events')}/${event.event_id}.json`;
    const stored = JSON.parse(safeReadFile(eventPath, { encoding: 'utf8' }) as string);

    const ajv = new Ajv({ allErrors: true });
    const validate = compileSchemaFromPath(ajv, path.join(pathResolver.rootDir(), 'knowledge/public/schemas/mission-orchestration-event.schema.json'));
    const valid = validate(stored);
    expect(valid, JSON.stringify(validate.errors || [])).toBe(true);
  });
});
