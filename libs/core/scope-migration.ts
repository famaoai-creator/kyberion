import { resolveRuntimeScope } from './runtime-scope.js';
import { normalizeEventScope, parseEventScopeFromRecord, type EventScope } from './event-scope.js';

export type ScopeMigrationDisposition =
  'canonical' | 'mission-derived' | 'unscoped-legacy' | 'invalid';

export interface ScopeMigrationResult {
  disposition: ScopeMigrationDisposition;
  scope?: EventScope;
}

export interface ScopeMigrationOptions {
  /** Test seam; production uses authoritative mission state. */
  resolveMissionScope?: (missionId: string) => EventScope | undefined;
}

type JsonRecord = Record<string, unknown>;

const COMPARABLE_SCOPE_KEYS = [
  'scope_kind',
  'tier',
  'tenant_slug',
  'organization_id',
  'project_id',
  'mission_id',
  'task_id',
  'session_id',
  'work_shape',
  'customer_stance',
  'viewer_principal',
  'nhi_id',
] as const;

function asRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function sameScope(left: EventScope, right: EventScope): boolean {
  return COMPARABLE_SCOPE_KEYS.every((key) => left[key] === right[key]);
}

function missionIdFrom(record: JsonRecord): string | undefined {
  const payload = asRecord(record.payload);
  const value = record.mission_id ?? payload?.mission_id;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return value.trim().toUpperCase();
}

function stringHint(record: JsonRecord, key: string, alias: string): string | undefined {
  const payload = asRecord(record.payload);
  const value = record[key] ?? record[alias] ?? payload?.[key] ?? payload?.[alias];
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return value.trim();
}

function legacyHintsMatchScope(record: JsonRecord, scope: EventScope): boolean {
  const tier = stringHint(record, 'tier', 'tier_scope');
  const tenant = stringHint(record, 'tenant_slug', 'tenant_id');
  const organization = stringHint(record, 'organization_id', 'organizationId');
  const project = stringHint(record, 'project_id', 'projectId');
  const mission = stringHint(record, 'mission_id', 'missionId');
  const task = stringHint(record, 'task_id', 'taskId');
  const session = stringHint(record, 'session_id', 'sessionId');
  const matches = (hint: string | undefined, value: string | undefined): boolean =>
    !hint || value === undefined || value === hint;
  return (
    matches(tier, scope.tier) &&
    matches(tenant, scope.tenant_slug) &&
    matches(organization, scope.organization_id) &&
    matches(project, scope.project_id) &&
    matches(mission?.toUpperCase(), scope.mission_id) &&
    matches(task, scope.task_id) &&
    matches(session, scope.session_id)
  );
}

function parseNestedScope(record: JsonRecord): {
  invalid: boolean;
  scope?: EventScope;
} {
  const hasNestedScope = record.scope !== undefined || record.scope_context !== undefined;
  if (!hasNestedScope) return { invalid: false };
  const result = parseEventScopeFromRecord(record);
  return { invalid: result.invalid, scope: result.scope };
}

/**
 * Resolve a durable record's scope without rewriting the original record.
 *
 * Legacy records may omit the nested scope. They are only promoted to a
 * tenant/entity scope when the mission state is still an authoritative source
 * for that mission. Unknown or malformed records remain unscoped so tenant
 * readers cannot infer ownership from a flat legacy field.
 */
export function resolveScopeForRecord(
  record: JsonRecord,
  options: ScopeMigrationOptions = {}
): ScopeMigrationResult {
  const payload = asRecord(record.payload);
  const recordScopeResult = parseNestedScope(record);
  const payloadScopeResult = payload ? parseNestedScope(payload) : undefined;
  if (recordScopeResult.invalid || payloadScopeResult?.invalid) {
    return { disposition: 'invalid' };
  }

  const recordScope = recordScopeResult.scope;
  const payloadScope = payloadScopeResult?.scope;
  if (recordScope && payloadScope && !sameScope(recordScope, payloadScope)) {
    return { disposition: 'invalid' };
  }
  const canonical = recordScope || payloadScope;
  const missionId = missionIdFrom(record);
  if (canonical) {
    if (missionId && canonical.mission_id && canonical.mission_id !== missionId) {
      return { disposition: 'invalid' };
    }
    if (!legacyHintsMatchScope(record, canonical)) {
      return { disposition: 'invalid' };
    }
    return { disposition: 'canonical', scope: canonical };
  }

  if (missionId) {
    try {
      const suppliedMissionScope = options.resolveMissionScope?.(missionId);
      if (suppliedMissionScope) {
        const scope = normalizeEventScope(suppliedMissionScope);
        return legacyHintsMatchScope(record, scope)
          ? { disposition: 'mission-derived', scope }
          : { disposition: 'invalid' };
      }
      const scope = normalizeEventScope(resolveRuntimeScope({ missionId }));
      return legacyHintsMatchScope(record, scope)
        ? { disposition: 'mission-derived', scope }
        : { disposition: 'invalid' };
    } catch {
      // The mission may have been archived or its old state may be incomplete.
      // Keep this record out of tenant projections rather than guessing.
    }
  }
  return { disposition: 'unscoped-legacy' };
}
