import { appendJsonLine } from './foundation/json.js';
import { readJsonIfPresent } from './foundation/json.js';
import { randomUUID } from 'node:crypto';
import * as nodePath from 'node:path';
import { findMissionPath, missionDir, pathResolver } from './path-resolver.js';
import { resolveSharedObservabilityDir } from './observability-gate.js';
import {
  assertSafeRepositoryPath,
  safeAppendFileSync,
  safeExistsSync,
  safeMkdir,
} from './secure-io.js';
import { appendMissionExecutionLedgerEntry } from './mission-team-binding.js';
import { redactCollaborationSummary } from './agent-collaboration-events.js';
import {
  normalizeEventScope,
  redactEventScopeForShared,
  resolveEventScopeAgainstAuthority,
  type EventScope,
  type EventScopeInput,
} from './event-scope.js';

export type MissionTaskEventType =
  | 'task_issued'
  | 'task_submitted'
  | 'task_reviewed'
  | 'task_completed'
  | 'task_accepted'
  | 'participant_context_resolved';

export interface MissionTaskEventInput {
  event_type: MissionTaskEventType;
  mission_id: string;
  task_id: string;
  agent_id?: string;
  team_role?: string;
  decision: string;
  why: string;
  policy_used: string;
  evidence?: string[];
  payload?: Record<string, unknown>;
  causation_id?: string;
  correlation_id?: string;
  scope?: EventScopeInput;
}

export interface MissionTaskEventIdentity {
  event_type: MissionTaskEventType;
  mission_id: string;
  task_id: string;
}

/** Parse the identity fields used by task-event deduplication. */
export function parseMissionTaskEventIdentity(
  value: unknown
): MissionTaskEventIdentity | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.mission_id !== 'string' ||
    !record.mission_id.trim() ||
    typeof record.task_id !== 'string' ||
    !record.task_id.trim() ||
    typeof record.event_type !== 'string'
  ) {
    return undefined;
  }
  switch (record.event_type) {
    case 'task_issued':
    case 'task_submitted':
    case 'task_reviewed':
    case 'task_completed':
    case 'task_accepted':
    case 'participant_context_resolved':
      return {
        event_type: record.event_type,
        mission_id: record.mission_id,
        task_id: record.task_id,
      };
    default:
      return undefined;
  }
}

/** Shared task events contain bounded metadata only; payload remains mission-local. */
export function redactMissionTaskEventForShared(
  event: MissionTaskEventInput & { event_id: string; ts: string; scope: EventScope }
): Record<string, unknown> {
  return {
    ts: event.ts,
    event_id: event.event_id,
    event_type: event.event_type,
    mission_id: event.mission_id,
    task_id: event.task_id,
    ...(event.agent_id ? { agent_id: event.agent_id } : {}),
    ...(event.team_role ? { team_role: event.team_role } : {}),
    decision: redactCollaborationSummary(event.decision, 'task event'),
    why: redactCollaborationSummary(event.why, 'task event'),
    policy_used: event.policy_used,
    ...(event.evidence
      ? { evidence: event.evidence.map((item) => redactCollaborationSummary(item, 'evidence')) }
      : {}),
    ...(event.causation_id ? { causation_id: event.causation_id } : {}),
    ...(event.correlation_id ? { correlation_id: event.correlation_id } : {}),
    scope: redactEventScopeForShared(event.scope),
  };
}

export function missionTaskEventsPath(
  missionId: string,
  fallbackTier: EventScope['tier'] = 'public',
  tenantSlug?: string
): string {
  pathResolver.assertMissionIdArgument(missionId);
  const missionPath =
    findMissionPath(missionId) ||
    (tenantSlug
      ? pathResolver.tenantMissionDir(missionId, tenantSlug, fallbackTier)
      : missionDir(missionId, fallbackTier));
  return assertSafeRepositoryPath(`${missionPath}/coordination/events/task-events.jsonl`, {
    allowMissingLeaf: true,
  });
}

function ensureTaskEventDirs(
  missionId: string,
  tier: EventScope['tier'],
  tenantSlug?: string
): {
  missionEventPath: string;
  globalEventPath: string;
} {
  const missionEventPath = missionTaskEventsPath(missionId, tier, tenantSlug);
  const globalEventsDir = assertSafeRepositoryPath(
    pathResolver.shared('observability/mission-control'),
    { allowMissingLeaf: true }
  );
  safeMkdir(nodePath.dirname(missionEventPath));
  safeMkdir(globalEventsDir);
  return {
    missionEventPath,
    globalEventPath: assertSafeRepositoryPath(`${globalEventsDir}/task-events.jsonl`, {
      allowMissingLeaf: true,
    }),
  };
}

export function emitMissionTaskEvent(input: MissionTaskEventInput): void {
  const scope = resolveTaskEventScope(input);
  const event = {
    ts: new Date().toISOString(),
    event_id: randomUUID(),
    ...input,
    scope,
  };
  const { missionEventPath, globalEventPath } = ensureTaskEventDirs(
    input.mission_id,
    scope.tier,
    scope.tenant_slug
  );
  const line = `${JSON.stringify(event)}\n`;
  safeAppendFileSync(missionEventPath, line);
  // The mission-local stream always records; the shared cross-mission stream
  // goes through the hermetic-test gate.
  const globalDir = resolveSharedObservabilityDir(nodePath.dirname(globalEventPath));
  if (globalDir) {
    safeMkdir(globalDir);
    appendJsonLine(`${globalDir}/task-events.jsonl`, redactMissionTaskEventForShared(event));
  }
  appendMissionExecutionLedgerEntry({
    mission_id: input.mission_id,
    source_event_id: event.event_id,
    event_type: input.event_type,
    task_id: input.task_id,
    team_role: input.team_role,
    actor_id: input.agent_id,
    actor_type: input.agent_id ? 'agent' : undefined,
    decision: input.decision,
    evidence: input.evidence,
    payload: input.payload,
    scope,
    mission_path_hint: nodePath.dirname(nodePath.dirname(nodePath.dirname(missionEventPath))),
  });
}

function resolveTaskEventScope(input: MissionTaskEventInput): EventScope {
  const suppliedTenant = input.scope?.tenant_slug || input.scope?.tenant_id;
  const suppliedTier = input.scope?.tier;
  const tenantMissionPath =
    suppliedTenant && suppliedTier
      ? pathResolver.tenantMissionDir(input.mission_id, suppliedTenant, suppliedTier)
      : undefined;
  const missionPath =
    findMissionPath(input.mission_id) ||
    (tenantMissionPath && safeExistsSync(tenantMissionPath)
      ? tenantMissionPath
      : missionDir(input.mission_id, 'public'));
  let authority: EventScope;
  try {
    const statePath = assertSafeRepositoryPath(`${missionPath}/mission-state.json`, {
      allowMissingLeaf: true,
    });
    const state = readJsonIfPresent<Record<string, unknown>>(statePath) ?? {};
    authority = normalizeEventScope({
      mission_id: input.mission_id,
      tier: (state.tier_scope || state.tier || 'public') as 'personal' | 'confidential' | 'public',
      ...(typeof state.tenant_slug === 'string' ? { tenant_slug: state.tenant_slug } : {}),
      ...(typeof state.organization_id === 'string'
        ? { organization_id: state.organization_id }
        : {}),
      ...(typeof state.project_id === 'string' ? { project_id: state.project_id } : {}),
    });
  } catch {
    authority = normalizeEventScope({ mission_id: input.mission_id, tier: 'public' });
  }
  return resolveEventScopeAgainstAuthority(authority, input.scope, {
    mission_id: input.mission_id,
    task_id: input.task_id,
    scope_kind: 'task',
  });
}
