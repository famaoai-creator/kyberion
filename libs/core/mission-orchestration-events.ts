import { appendJsonLine } from './foundation/json.js';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { pathResolver, rootDir } from './path-resolver.js';
import { safeAppendFileSync, safeMkdir, safeWriteFile } from './secure-io.js';
import { resolveSharedObservabilityDir } from './observability-gate.js';
import { spawnManagedProcess } from './managed-process.js';
import { appendMissionOrchestrationJournalEntry } from './mission-orchestration-journal.js';
import { getDefaultWorkerEventStream } from './worker-event-stream.js';
import { redactEventScopeForShared, type EventScope, type EventScopeInput } from './event-scope.js';
import { redactCollaborationMetadata } from './agent-collaboration-events.js';
import {
  resolveMissionOrchestrationScope,
  loadMissionOrchestrationEvent,
} from './mission-orchestration-event-loader.js';
export {
  loadMissionOrchestrationEvent,
  resolveMissionOrchestrationScope,
} from './mission-orchestration-event-loader.js';
export {
  MISSION_ORCHESTRATION_EVENT_TYPES,
  type MissionOrchestrationEvent,
  type MissionOrchestrationEventType,
} from './mission-orchestration-event-contract.js';
import type {
  MissionOrchestrationEvent,
  MissionOrchestrationEventType,
} from './mission-orchestration-event-contract.js';

const EVENTS_DIR = pathResolver.shared('coordination/orchestration/events');
const OBS_DIR = pathResolver.shared('observability/mission-control');
const PAYLOAD_SUBDIR = path.join('coordination', 'orchestration', 'payloads');

function ensureDirs(): void {
  safeMkdir(EVENTS_DIR);
  safeMkdir(OBS_DIR);
}

export function getMissionOrchestrationEventPath(eventId: string): string {
  ensureDirs();
  return `${EVENTS_DIR}/${eventId}.json`;
}

export function emitMissionOrchestrationObservation(event: Record<string, unknown>): void {
  const sharedEvent = {
    ...redactCollaborationMetadata(event),
    ...(event.scope && typeof event.scope === 'object'
      ? { scope: redactEventScopeForShared(event.scope as EventScope) }
      : {}),
  };
  try {
    getDefaultWorkerEventStream().emit('mission_event', sharedEvent, {
      ...(typeof event.mission_id === 'string' ? { mission_id: event.mission_id } : {}),
    });
  } catch {
    /* stream projection is best-effort; the jsonl observation below is the SSoT */
  }
  const obsDir = resolveSharedObservabilityDir(OBS_DIR);
  if (!obsDir) return;
  safeMkdir(EVENTS_DIR);
  safeMkdir(obsDir);
  appendJsonLine(`${obsDir}/orchestration-events.jsonl`, {
    ts: new Date().toISOString(),
    ...sharedEvent,
  });
}

function missionPayloadPath(
  missionId: string,
  tier: EventScope['tier'],
  eventId: string,
  scopeTenantSlug?: string
): string {
  const missionPath =
    pathResolver.findMissionPath(missionId) ||
    (scopeTenantSlug
      ? pathResolver.tenantMissionDir(missionId, scopeTenantSlug, tier)
      : pathResolver.missionDir(missionId, tier));
  return path.join(missionPath, PAYLOAD_SUBDIR, `${eventId}.json`);
}

export function enqueueMissionOrchestrationEvent<TPayload = Record<string, unknown>>(input: {
  eventType: MissionOrchestrationEventType;
  missionId: string;
  requestedBy: string;
  payload: TPayload;
  correlationId?: string;
  causationId?: string;
  scope?: EventScopeInput;
}): MissionOrchestrationEvent<TPayload> {
  ensureDirs();
  pathResolver.assertMissionIdArgument(input.missionId);
  const scope = resolveMissionOrchestrationScope(input.missionId, input.scope);
  const eventId = `ME-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 8).toUpperCase()}`;
  const payloadPath = missionPayloadPath(input.missionId, scope.tier, eventId, scope.tenant_slug);
  const payloadRef = pathResolver.toRepoRelative(payloadPath);
  safeMkdir(path.dirname(payloadPath), { recursive: true });
  safeWriteFile(
    payloadPath,
    JSON.stringify(
      { event_id: eventId, mission_id: input.missionId.toUpperCase(), payload: input.payload },
      null,
      2
    )
  );
  const event: MissionOrchestrationEvent<TPayload> = {
    event_id: eventId,
    event_type: input.eventType,
    mission_id: input.missionId.toUpperCase(),
    requested_by: input.requestedBy,
    created_at: new Date().toISOString(),
    correlation_id: input.correlationId,
    causation_id: input.causationId,
    scope,
    payload_ref: payloadRef,
    payload: input.payload,
  };
  const queueEvent = {
    ...event,
    scope: redactEventScopeForShared(scope),
    payload: {},
  };
  safeWriteFile(
    getMissionOrchestrationEventPath(event.event_id),
    JSON.stringify(queueEvent, null, 2)
  );
  appendMissionOrchestrationJournalEntry({
    missionId: event.mission_id,
    eventId: event.event_id,
    eventType: event.event_type,
    status: 'enqueued',
    payload: event.payload,
    requestedBy: event.requested_by,
    causationId: event.causation_id,
    correlationId: event.correlation_id,
    scope,
  });
  emitMissionOrchestrationObservation({
    decision: 'mission_orchestration_event_enqueued',
    event_id: event.event_id,
    event_type: event.event_type,
    mission_id: event.mission_id,
    requested_by: event.requested_by,
    scope: event.scope,
  });
  return event;
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
