import { readJson } from './foundation/json.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import * as path from 'node:path';
import { findMissionPath, pathResolver } from './path-resolver.js';
import { assertSafeRepositoryPath, safeExistsSync } from './secure-io.js';
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

function missionOrchestrationEventCatalog(eventPath: string) {
  return defineCatalog<Partial<MissionOrchestrationEvent>>({
    id: 'mission-orchestration-event',
    path: eventPath,
    schema: EVENT_SCHEMA_PATH,
  });
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
    const state = statePath ? readJson<Record<string, unknown>>(statePath) : {};
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
    const payloadEnvelope = readJson<{
      event_id?: unknown;
      mission_id?: unknown;
      payload?: unknown;
    }>(payloadPath);
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

export { resolveMissionOrchestrationScope };
