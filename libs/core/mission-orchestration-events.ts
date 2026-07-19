import { randomUUID } from 'node:crypto';
import { pathResolver, rootDir } from './path-resolver.js';
import { safeAppendFileSync, safeMkdir, safeReadFile, safeWriteFile } from './secure-io.js';
import { resolveSharedObservabilityDir } from './observability-gate.js';
import { spawnManagedProcess } from './managed-process.js';
import { appendMissionOrchestrationJournalEntry } from './mission-orchestration-journal.js';
import { getDefaultWorkerEventStream } from './worker-event-stream.js';

export type MissionOrchestrationEventType =
  | 'mission_issue_requested'
  | 'mission_team_prewarm_requested'
  | 'mission_kickoff_requested'
  | 'mission_followup_requested'
  | 'mission_reconciliation_requested'
  | 'mission_distillation_requested'
  | 'mission_completion_requested'
  | 'mission_control_requested'
  | 'surface_control_requested';

export interface MissionOrchestrationEvent<TPayload = Record<string, unknown>> {
  event_id: string;
  event_type: MissionOrchestrationEventType;
  mission_id: string;
  requested_by: string;
  created_at: string;
  correlation_id?: string;
  causation_id?: string;
  payload: TPayload;
}

const EVENTS_DIR = pathResolver.shared('coordination/orchestration/events');
const OBS_DIR = pathResolver.shared('observability/mission-control');

function ensureDirs(): void {
  safeMkdir(EVENTS_DIR);
  safeMkdir(OBS_DIR);
}

export function getMissionOrchestrationEventPath(eventId: string): string {
  ensureDirs();
  return `${EVENTS_DIR}/${eventId}.json`;
}

export function emitMissionOrchestrationObservation(event: Record<string, unknown>): void {
  try {
    getDefaultWorkerEventStream().emit('mission_event', event, {
      ...(typeof event.mission_id === 'string' ? { mission_id: event.mission_id } : {}),
    });
  } catch {
    /* stream projection is best-effort; the jsonl observation below is the SSoT */
  }
  const obsDir = resolveSharedObservabilityDir(OBS_DIR);
  if (!obsDir) return;
  safeMkdir(EVENTS_DIR);
  safeMkdir(obsDir);
  safeAppendFileSync(
    `${obsDir}/orchestration-events.jsonl`,
    `${JSON.stringify({
      ts: new Date().toISOString(),
      ...event,
    })}\n`
  );
}

export function enqueueMissionOrchestrationEvent<TPayload = Record<string, unknown>>(input: {
  eventType: MissionOrchestrationEventType;
  missionId: string;
  requestedBy: string;
  payload: TPayload;
  correlationId?: string;
  causationId?: string;
}): MissionOrchestrationEvent<TPayload> {
  ensureDirs();
  const event: MissionOrchestrationEvent<TPayload> = {
    event_id: `ME-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 8).toUpperCase()}`,
    event_type: input.eventType,
    mission_id: input.missionId.toUpperCase(),
    requested_by: input.requestedBy,
    created_at: new Date().toISOString(),
    correlation_id: input.correlationId,
    causation_id: input.causationId,
    payload: input.payload,
  };
  safeWriteFile(getMissionOrchestrationEventPath(event.event_id), JSON.stringify(event, null, 2));
  appendMissionOrchestrationJournalEntry({
    missionId: event.mission_id,
    eventId: event.event_id,
    eventType: event.event_type,
    status: 'enqueued',
    payload: event.payload,
    requestedBy: event.requested_by,
    causationId: event.causation_id,
    correlationId: event.correlation_id,
  });
  emitMissionOrchestrationObservation({
    decision: 'mission_orchestration_event_enqueued',
    event_id: event.event_id,
    event_type: event.event_type,
    mission_id: event.mission_id,
    requested_by: event.requested_by,
  });
  return event;
}

export function loadMissionOrchestrationEvent<TPayload = Record<string, unknown>>(
  eventPath: string
): MissionOrchestrationEvent<TPayload> {
  return JSON.parse(
    safeReadFile(eventPath, { encoding: 'utf8' }) as string
  ) as MissionOrchestrationEvent<TPayload>;
}

export function startMissionOrchestrationWorker<TPayload = Record<string, unknown>>(
  event: MissionOrchestrationEvent<TPayload>
): string {
  const eventPath = getMissionOrchestrationEventPath(event.event_id);
  spawnManagedProcess({
    resourceId: `mission-orchestration:${event.event_id}`,
    kind: 'service',
    ownerId: event.mission_id,
    ownerType: 'mission-orchestration-worker',
    command: process.execPath,
    args: ['dist/scripts/run_mission_orchestration_event_worker.js', '--event', eventPath],
    spawnOptions: {
      cwd: rootDir(),
      env: process.env,
      detached: true,
      stdio: 'ignore',
    },
    shutdownPolicy: 'detached',
    metadata: {
      eventId: event.event_id,
      missionId: event.mission_id,
      eventType: event.event_type,
    },
  });
  return eventPath;
}
