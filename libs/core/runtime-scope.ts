import * as path from 'node:path';
import { getAgentIdentity } from './agent-identity.js';
import {
  normalizeEventScope,
  resolveEventScopeAgainstAuthority,
  type EventScope,
  type EventScopeInput,
} from './event-scope.js';
import { findMissionPath } from './path-resolver.js';
import { readJson } from './foundation/json.js';
import { safeExistsSync } from './secure-io.js';
import { loadProjectRecord } from './project-registry.js';
import type { TierLevel } from './types.js';

export type RuntimeProcessScope = 'system' | 'tenant-service';

export interface RuntimeScopeResolutionInput {
  missionId?: string;
  scope?: EventScopeInput;
  authorityScope?: EventScopeInput;
}

interface MissionScopeState {
  mission_id?: unknown;
  tier?: unknown;
  tenant_slug?: unknown;
  tenant_id?: unknown;
  organization_id?: unknown;
  relationships?: {
    project?: { project_id?: unknown; organization_id?: unknown };
  };
}

const TIERS: readonly TierLevel[] = ['personal', 'confidential', 'public'];

function normalizeMissionId(missionId?: string): string | undefined {
  const value = missionId?.trim();
  return value ? value.toUpperCase() : undefined;
}

function readMissionScope(missionId: string): EventScope | null {
  const missionPath = findMissionPath(missionId);
  if (!missionPath) return null;
  const statePath = path.join(missionPath, 'mission-state.json');
  if (!safeExistsSync(statePath)) return null;

  const state = readJson<MissionScopeState>(statePath);
  const stateMissionId = normalizeMissionId(
    typeof state.mission_id === 'string' ? state.mission_id : missionId
  );
  if (!stateMissionId || stateMissionId !== missionId) {
    throw new Error(
      `[RUNTIME_SCOPE_AUTHORITY_INVALID] mission-state mission_id does not match '${missionId}'`
    );
  }
  const tier = state.tier as TierLevel;
  if (!TIERS.includes(tier)) {
    throw new Error(`[RUNTIME_SCOPE_AUTHORITY_INVALID] mission '${missionId}' has invalid tier`);
  }

  const tenantSlug =
    (typeof state.tenant_slug === 'string' && state.tenant_slug.trim()) ||
    (typeof state.tenant_id === 'string' && state.tenant_id.trim()) ||
    undefined;
  const organizationId =
    typeof state.organization_id === 'string' && state.organization_id.trim()
      ? state.organization_id.trim()
      : undefined;
  const projectId =
    typeof state.relationships?.project?.project_id === 'string' &&
    state.relationships.project.project_id.trim()
      ? state.relationships.project.project_id.trim()
      : undefined;
  const relationOrganizationId =
    typeof state.relationships?.project?.organization_id === 'string' &&
    state.relationships.project.organization_id.trim()
      ? state.relationships.project.organization_id.trim()
      : undefined;
  const projectRecord = projectId ? loadProjectRecord(projectId) : null;
  const registryOrganizationId =
    projectRecord &&
    projectRecord.tier === tier &&
    (!tenantSlug || projectRecord.tenant_slug === tenantSlug)
      ? projectRecord.organization_id
      : undefined;
  const resolvedOrganizationId = registryOrganizationId || organizationId || relationOrganizationId;

  return normalizeEventScope({
    scope_kind: 'mission',
    tier,
    mission_id: missionId,
    ...(tenantSlug ? { tenant_slug: tenantSlug } : {}),
    ...(resolvedOrganizationId ? { organization_id: resolvedOrganizationId } : {}),
    ...(projectId ? { project_id: projectId } : {}),
  });
}

/** Resolve a runtime request against mission state or an explicit scope. */
export function resolveRuntimeScope(input: RuntimeScopeResolutionInput = {}): EventScope {
  const missionId = normalizeMissionId(input.missionId);
  const missionAuthority = missionId ? readMissionScope(missionId) : undefined;
  const authority = input.authorityScope
    ? normalizeEventScope(input.authorityScope)
    : missionAuthority;

  let scope: EventScope;
  if (authority && input.scope) {
    scope = resolveEventScopeAgainstAuthority(authority, input.scope);
  } else if (authority) {
    scope = authority;
  } else if (input.scope) {
    scope = normalizeEventScope(input.scope);
  } else if (missionId) {
    throw new Error(
      `[RUNTIME_SCOPE_REQUIRED] mission '${missionId}' has no authoritative runtime scope`
    );
  } else {
    scope = normalizeEventScope({ scope_kind: 'system', tier: 'public' });
  }

  if (missionId && scope.mission_id !== missionId) {
    throw new Error(
      `[RUNTIME_SCOPE_LINEAGE_CONFLICT] mission_id '${scope.mission_id || ''}' does not match '${missionId}'`
    );
  }
  return scope;
}

/** Check a runtime instance's recorded scope before reusing it for a request. */
export function assertRuntimeScopeCompatible(
  actual: EventScope | undefined,
  requested: EventScope
): void {
  if (!actual) return;
  const containmentKeys = [
    'tenant_slug',
    'organization_id',
    'project_id',
    'mission_id',
    'task_id',
    'session_id',
  ] as const;
  for (const key of containmentKeys) {
    const actualValue = actual[key];
    const requestedValue = requested[key];
    if (actualValue && actualValue !== requestedValue) {
      throw new Error(
        `[RUNTIME_SCOPE_MISMATCH] runtime ${key} '${actualValue}' cannot serve '${requestedValue || 'unscoped'}'`
      );
    }
  }
  if (actual.tier !== requested.tier) {
    throw new Error(
      `[RUNTIME_SCOPE_MISMATCH] runtime tier '${actual.tier}' cannot serve '${requested.tier}'`
    );
  }
}

/** Validate NHI affiliation without allowing identity metadata to widen scope. */
export function assertRuntimeNhiScope(scope: EventScope, nhiId = scope.nhi_id): void {
  if (!nhiId) return;
  if (scope.nhi_id && scope.nhi_id !== nhiId) {
    throw new Error(
      `[RUNTIME_NHI_SCOPE_MISMATCH] scope nhi_id '${scope.nhi_id}' does not match '${nhiId}'`
    );
  }
  const identity = getAgentIdentity(nhiId);
  if (!identity) {
    throw new Error(`[RUNTIME_NHI_UNKNOWN] NHI '${nhiId}' is not registered`);
  }
  const affiliation = identity.affiliation;
  if (affiliation.tenant_slug && affiliation.tenant_slug !== scope.tenant_slug) {
    throw new Error(
      `[RUNTIME_NHI_TENANT_MISMATCH] NHI '${nhiId}' belongs to tenant '${affiliation.tenant_slug}', not '${scope.tenant_slug || 'system'}'`
    );
  }
  if (affiliation.organization_id && scope.organization_id) {
    if (affiliation.organization_id !== scope.organization_id) {
      throw new Error(
        `[RUNTIME_NHI_ORGANIZATION_MISMATCH] NHI '${nhiId}' belongs to organization '${affiliation.organization_id}', not '${scope.organization_id}'`
      );
    }
  }
}
