import { defineCatalog } from './foundation/governed-catalog.js';
import * as path from 'node:path';
import { findMissionPath, pathResolver } from './path-resolver.js';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat } from './secure-io.js';
import { loadMissionStateAtPath } from './mission-state-reader.js';
import {
  normalizeEventScope,
  resolveEventScopeAgainstAuthority,
  type EventScope,
  type EventScopeInput,
} from './event-scope.js';
import {
  MISSION_ORCHESTRATION_EVENT_TYPES,
  type MissionOrchestrationEvent,
  type MissionOrchestrationEventType,
} from './mission-orchestration-event-contract.js';

const EVENT_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/mission-orchestration-event.schema.json'
);
const PAYLOAD_ENVELOPE_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/mission-orchestration-payload-envelope.schema.json'
);

function missionOrchestrationEventCatalog(eventPath: string) {
  return defineCatalog<Partial<MissionOrchestrationEvent>>({
    id: 'mission-orchestration-event',
    path: eventPath,
    schema: EVENT_SCHEMA_PATH,
  });
}

interface MissionOrchestrationPayloadEnvelope<TPayload = Record<string, unknown>> {
  event_id: string;
  mission_id: string;
  payload: TPayload;
}

function missionOrchestrationPayloadEnvelopeCatalog(payloadPath: string) {
  return defineCatalog<MissionOrchestrationPayloadEnvelope>({
    id: 'mission-orchestration-payload-envelope',
    path: payloadPath,
    schema: PAYLOAD_ENVELOPE_SCHEMA_PATH,
  });
}

export function validateMissionOrchestrationPayloadEnvelope<TPayload = Record<string, unknown>>(
  value: unknown,
  sourcePath: string
): MissionOrchestrationPayloadEnvelope<TPayload> {
  return missionOrchestrationPayloadEnvelopeCatalog(sourcePath).validate(
    value,
    sourcePath
  ) as MissionOrchestrationPayloadEnvelope<TPayload>;
}

/** Load a mission payload envelope through schema, regular-file, and event bindings. */
export function loadMissionOrchestrationPayloadEnvelopeAtPath<TPayload = Record<string, unknown>>(
  payloadPath: string,
  expectedEventId: string,
  expectedMissionId: string
): MissionOrchestrationPayloadEnvelope<TPayload> {
  const safePayloadPath = assertSafeRepositoryPath(payloadPath, { allowMissingLeaf: false });
  if (!safeLstat(safePayloadPath).isFile()) {
    throw new Error(
      `[MISSION_ORCHESTRATION_PAYLOAD_INVALID] payload must be a regular file: ${payloadPath}`
    );
  }
  const envelope = missionOrchestrationPayloadEnvelopeCatalog(
    safePayloadPath
  ).load() as MissionOrchestrationPayloadEnvelope<TPayload>;
  if (envelope.event_id !== expectedEventId) {
    throw new Error(
      `[MISSION_ORCHESTRATION_PAYLOAD_SCOPE_MISMATCH] payload belongs to event ${envelope.event_id}, expected ${expectedEventId}`
    );
  }
  if (envelope.mission_id.toUpperCase() !== expectedMissionId.toUpperCase()) {
    throw new Error(
      `[MISSION_ORCHESTRATION_PAYLOAD_SCOPE_MISMATCH] payload belongs to mission ${envelope.mission_id}, expected ${expectedMissionId}`
    );
  }
  return envelope;
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
          try {
            const safeCandidate = assertSafeRepositoryPath(candidate, { allowMissingLeaf: false });
            return safeExistsSync(safeCandidate) ? safeCandidate : undefined;
          } catch {
            return undefined;
          }
        })()
      : undefined);
  let statePath: string | undefined;
  try {
    statePath = locatedMissionPath
      ? assertSafeRepositoryPath(path.join(locatedMissionPath, 'mission-state.json'), {
          allowMissingLeaf: false,
        })
      : undefined;
  } catch {
    statePath = undefined;
  }
  try {
    const state = statePath ? loadMissionStateAtPath(statePath) : null;
    const authority = normalizeEventScope({
      mission_id: missionId,
      tier: state?.tier || 'public',
      ...(state?.tenant_slug ? { tenant_slug: state.tenant_slug } : {}),
      ...(state?.organization_id ? { organization_id: state.organization_id } : {}),
      ...(state?.relationships?.project?.project_id
        ? { project_id: state.relationships.project.project_id }
        : {}),
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

export function loadMissionOrchestrationEvent<TPayload = Record<string, unknown>>(
  eventPath: string
): MissionOrchestrationEvent<TPayload> {
  const safeEventPath = assertSafeRepositoryPath(eventPath, { allowMissingLeaf: false });
  let parsed: Partial<MissionOrchestrationEvent<TPayload>>;
  try {
    parsed = missionOrchestrationEventCatalog(safeEventPath).load() as Partial<
      MissionOrchestrationEvent<TPayload>
    >;
  } catch (error) {
    if (error instanceof SyntaxError) throw error;
    throw new Error(
      `[MISSION_ORCHESTRATION_EVENT_INVALID] ${error instanceof Error ? error.message : String(error)}`
    );
  }
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
    const payloadPath = assertSafeRepositoryPath(pathResolver.rootResolve(parsed.payload_ref), {
      allowMissingLeaf: false,
    });
    try {
      parsed.payload = loadMissionOrchestrationPayloadEnvelopeAtPath<TPayload>(
        payloadPath,
        parsed.event_id,
        parsed.mission_id
      ).payload;
    } catch (error) {
      throw new Error(
        `[MISSION_ORCHESTRATION_EVENT_INVALID] ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  return {
    ...parsed,
    mission_id: parsed.mission_id.toUpperCase(),
    scope: resolveMissionOrchestrationScope(parsed.mission_id, parsed.scope),
  } as MissionOrchestrationEvent<TPayload>;
}

export { resolveMissionOrchestrationScope };
