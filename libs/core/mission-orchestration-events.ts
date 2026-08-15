import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { findMissionPath, pathResolver, rootDir } from './path-resolver.js';
import {
  safeAppendFileSync,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeWriteFile,
} from './secure-io.js';
import { resolveSharedObservabilityDir } from './observability-gate.js';
import { spawnManagedProcess } from './managed-process.js';
import { appendMissionOrchestrationJournalEntry } from './mission-orchestration-journal.js';
import { getDefaultWorkerEventStream } from './worker-event-stream.js';
import {
  normalizeEventScope,
  redactEventScopeForShared,
  resolveEventScopeAgainstAuthority,
  type EventScope,
  type EventScopeInput,
} from './event-scope.js';
import { redactCollaborationMetadata } from './agent-collaboration-events.js';

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

const MISSION_ORCHESTRATION_EVENT_TYPES: readonly MissionOrchestrationEventType[] = [
  'mission_issue_requested',
  'mission_team_prewarm_requested',
  'mission_kickoff_requested',
  'mission_followup_requested',
  'mission_reconciliation_requested',
  'mission_distillation_requested',
  'mission_completion_requested',
  'mission_control_requested',
  'surface_control_requested',
];

export interface MissionOrchestrationEvent<TPayload = Record<string, unknown>> {
  event_id: string;
  event_type: MissionOrchestrationEventType;
  mission_id: string;
  requested_by: string;
  created_at: string;
  correlation_id?: string;
  causation_id?: string;
  scope?: EventScope;
  /** Repo-relative mission-local payload; never contains raw payload in shared queue files. */
  payload_ref?: string;
  payload: TPayload;
}

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
  safeAppendFileSync(
    `${obsDir}/orchestration-events.jsonl`,
    `${JSON.stringify({
      ts: new Date().toISOString(),
      ...sharedEvent,
    })}\n`
  );
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

function isSafePayloadReference(
  reference: unknown,
  missionId: string,
  eventId: string
): reference is string {
  if (typeof reference !== 'string' || path.isAbsolute(reference)) return false;
  const normalized = reference.replaceAll('\\', '/');
  if (normalized.includes('../') || normalized.startsWith('../')) return false;
  const allowedRoot =
    normalized.startsWith('active/missions/') ||
    normalized.startsWith('knowledge/personal/missions/');
  return (
    allowedRoot &&
    normalized.includes(`/${missionId.toUpperCase()}/`) &&
    normalized.endsWith(`/coordination/orchestration/payloads/${eventId}.json`)
  );
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

function resolveMissionOrchestrationScope(
  missionId: string,
  supplied?: EventScopeInput
): EventScope {
  const locatedMissionPath =
    findMissionPath(missionId) ||
    (supplied?.tenant_slug && supplied.tier
      ? (() => {
          const candidate = pathResolver.tenantMissionDir(
            missionId,
            supplied.tenant_slug,
            supplied.tier!
          );
          return safeExistsSync(candidate) ? candidate : undefined;
        })()
      : undefined);
  const statePath = locatedMissionPath ? `${locatedMissionPath}/mission-state.json` : undefined;
  try {
    const state = statePath
      ? (JSON.parse(String(safeReadFile(statePath, { encoding: 'utf8' }) || '{}')) as Record<
          string,
          unknown
        >)
      : {};
    const authority = normalizeEventScope({
      mission_id: missionId,
      tier: (state.tier_scope || state.tier || 'public') as EventScope['tier'],
      ...(typeof state.tenant_slug === 'string' ? { tenant_slug: state.tenant_slug } : {}),
      ...(typeof state.organization_id === 'string'
        ? { organization_id: state.organization_id }
        : {}),
      ...(typeof state.project_id === 'string' ? { project_id: state.project_id } : {}),
    });
    return resolveEventScopeAgainstAuthority(authority, supplied, {
      mission_id: missionId,
      scope_kind: 'mission',
    });
  } catch {
    const authority = normalizeEventScope({ mission_id: missionId, tier: 'public' });
    return resolveEventScopeAgainstAuthority(authority, supplied, {
      mission_id: missionId,
      scope_kind: 'mission',
    });
  }
}

export function loadMissionOrchestrationEvent<TPayload = Record<string, unknown>>(
  eventPath: string
): MissionOrchestrationEvent<TPayload> {
  const parsed = JSON.parse(safeReadFile(eventPath, { encoding: 'utf8' }) as string) as Partial<
    MissionOrchestrationEvent<TPayload>
  >;
  if (
    typeof parsed.event_id !== 'string' ||
    typeof parsed.event_type !== 'string' ||
    !MISSION_ORCHESTRATION_EVENT_TYPES.includes(
      parsed.event_type as MissionOrchestrationEventType
    ) ||
    typeof parsed.mission_id !== 'string' ||
    typeof parsed.requested_by !== 'string' ||
    typeof parsed.payload !== 'object' ||
    parsed.payload === null
  ) {
    throw new Error('[MISSION_ORCHESTRATION_EVENT_INVALID] required fields are missing');
  }
  if (parsed.payload_ref !== undefined) {
    if (!isSafePayloadReference(parsed.payload_ref, parsed.mission_id, parsed.event_id)) {
      throw new Error(
        '[MISSION_ORCHESTRATION_EVENT_INVALID] payload_ref is outside the mission payload store'
      );
    }
    const payloadEnvelope = JSON.parse(
      String(
        safeReadFile(pathResolver.rootResolve(parsed.payload_ref), { encoding: 'utf8' }) || '{}'
      )
    ) as { event_id?: unknown; mission_id?: unknown; payload?: unknown };
    if (
      payloadEnvelope.event_id !== parsed.event_id ||
      payloadEnvelope.mission_id !== parsed.mission_id.toUpperCase() ||
      !payloadEnvelope.payload ||
      typeof payloadEnvelope.payload !== 'object' ||
      Array.isArray(payloadEnvelope.payload)
    ) {
      throw new Error(
        '[MISSION_ORCHESTRATION_EVENT_INVALID] mission payload reference envelope is invalid'
      );
    }
    parsed.payload = payloadEnvelope.payload as TPayload;
  }
  return {
    ...parsed,
    mission_id: parsed.mission_id.toUpperCase(),
    scope: resolveMissionOrchestrationScope(parsed.mission_id, parsed.scope),
  } as MissionOrchestrationEvent<TPayload>;
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
