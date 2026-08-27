import {
  assertScopeContext,
  type ScopeContext,
  type ScopeContextInput,
} from './scope-context-validation.js';
import { isValidTenantSlug } from './entity-scope.js';
import type { TierLevel } from './types.js';

/** The deepest entity boundary carried by an event or ledger record. */
export type EventScopeKind =
  'system' | 'tenant' | 'organization' | 'project' | 'mission' | 'task' | 'session';

export interface EventScope extends ScopeContext {
  scope_kind: EventScopeKind;
}

export interface EventScopeInput extends ScopeContextInput {
  scope_kind?: EventScopeKind;
}

export interface EventScopeFilter {
  tenant_slug?: string;
  tenant_slugs?: string[] | 'all';
  organization_id?: string;
  project_id?: string;
  mission_id?: string;
  task_id?: string;
  session_id?: string;
  scope_kind?: EventScopeKind;
}

export interface EventScopeRecordResult {
  has_scope: boolean;
  invalid: boolean;
  scope?: EventScope;
}

const EVENT_SCOPE_KINDS: readonly EventScopeKind[] = [
  'system',
  'tenant',
  'organization',
  'project',
  'mission',
  'task',
  'session',
];

const CONTAINMENT_KEYS: Array<keyof ScopeContext> = [
  'tenant_slug',
  'organization_id',
  'project_id',
  'mission_id',
  'task_id',
  'session_id',
];

const HIERARCHY: Array<[EventScopeKind, keyof ScopeContext]> = [
  ['session', 'session_id'],
  ['task', 'task_id'],
  ['mission', 'mission_id'],
  ['project', 'project_id'],
  ['organization', 'organization_id'],
  ['tenant', 'tenant_slug'],
];

function deepestScopeKind(context: ScopeContext): EventScopeKind {
  for (const [kind, key] of HIERARCHY) {
    if (context[key]) return kind;
  }
  return 'system';
}

function requiredForKind(kind: EventScopeKind, context: ScopeContext): boolean {
  if (!EVENT_SCOPE_KINDS.includes(kind)) return false;
  if (kind === 'system')
    return (
      !context.tenant_slug &&
      !context.organization_id &&
      !context.project_id &&
      !context.mission_id &&
      !context.task_id &&
      !context.session_id
    );
  if (kind === 'tenant') return Boolean(context.tenant_slug);
  if (kind === 'organization') return Boolean(context.organization_id && context.tenant_slug);
  if (kind === 'project')
    return Boolean(context.project_id && context.organization_id && context.tenant_slug);
  if (kind === 'mission') return Boolean(context.mission_id);
  if (kind === 'task') return Boolean(context.task_id && context.mission_id);
  return Boolean(context.session_id && context.task_id && context.mission_id);
}

/** Normalize an event's scope while keeping customer stance outside authority. */
export function normalizeEventScope(input: EventScopeInput): EventScope {
  const context = assertScopeContext(
    { ...input, tier: input.tier ?? ('public' as TierLevel) },
    { allowShared: false }
  );
  const scopeKind = input.scope_kind ?? deepestScopeKind(context);
  if (!requiredForKind(scopeKind, context)) {
    throw new Error(`[EVENT_SCOPE_INVALID] scope_kind '${scopeKind}' does not match its context`);
  }
  if (context.tenant_slug && !isValidTenantSlug(context.tenant_slug)) {
    throw new Error(`[EVENT_SCOPE_INVALID] tenant_slug '${context.tenant_slug}' is not a tenant`);
  }
  return { ...context, scope_kind: scopeKind };
}

/**
 * Resolve a supplied scope against the authoritative parent scope.
 * Containment and tier are never caller-controlled: an omitted value inherits
 * from the authority, while a conflicting value is rejected.
 */
export function resolveEventScopeAgainstAuthority(
  authorityInput: EventScopeInput,
  suppliedInput: EventScopeInput | undefined,
  overrides: EventScopeInput = {}
): EventScope {
  const authority = normalizeEventScope(authorityInput);
  const supplied = suppliedInput || {};
  const suppliedTenant = supplied.tenant_slug ?? supplied.tenant_id;

  for (const key of CONTAINMENT_KEYS) {
    const suppliedValue = key === 'tenant_slug' ? suppliedTenant : supplied[key];
    const authorityValue = authority[key];
    if (
      suppliedValue !== undefined &&
      String(suppliedValue).trim() !== String(authorityValue ?? '')
    ) {
      throw new Error(
        `[EVENT_SCOPE_LINEAGE_CONFLICT] ${key} '${String(suppliedValue)}' does not match authoritative scope '${String(authorityValue ?? '')}'`
      );
    }
  }
  if (supplied.tier !== undefined && supplied.tier !== authority.tier) {
    throw new Error(
      `[EVENT_SCOPE_LINEAGE_CONFLICT] tier '${String(supplied.tier)}' does not match authoritative tier '${authority.tier}'`
    );
  }

  return normalizeEventScope({
    ...authority,
    ...supplied,
    ...overrides,
    ...(authority.tenant_slug ? { tenant_slug: authority.tenant_slug } : {}),
    ...(authority.organization_id ? { organization_id: authority.organization_id } : {}),
    ...(authority.project_id ? { project_id: authority.project_id } : {}),
    ...(authority.mission_id ? { mission_id: authority.mission_id } : {}),
  });
}

/** Remove identity and stance metadata before a scope enters shared observability. */
export function redactEventScopeForShared(scope: EventScope): EventScope {
  return normalizeEventScope({
    scope_kind: scope.scope_kind,
    tier: scope.tier,
    ...(scope.tenant_slug ? { tenant_slug: scope.tenant_slug } : {}),
    ...(scope.organization_id ? { organization_id: scope.organization_id } : {}),
    ...(scope.project_id ? { project_id: scope.project_id } : {}),
    ...(scope.mission_id ? { mission_id: scope.mission_id } : {}),
    ...(scope.task_id ? { task_id: scope.task_id } : {}),
    ...(scope.session_id ? { session_id: scope.session_id } : {}),
    ...(scope.work_shape ? { work_shape: scope.work_shape } : {}),
  });
}

/** Fail closed when a tenant or entity-specific reader evaluates a record. */
export function eventScopeMatches(
  scope: EventScope | undefined,
  filter: EventScopeFilter
): boolean {
  if (!scope) {
    const hasEntityFilter = Boolean(
      filter.tenant_slug ||
      (filter.tenant_slugs && filter.tenant_slugs !== 'all') ||
      filter.organization_id ||
      filter.project_id ||
      filter.mission_id ||
      filter.task_id ||
      filter.session_id
    );
    return !hasEntityFilter && (!filter.scope_kind || filter.scope_kind === 'system');
  }
  if (filter.scope_kind && scope?.scope_kind !== filter.scope_kind) return false;
  const requestedTenants =
    filter.tenant_slugs === 'all'
      ? null
      : filter.tenant_slugs || (filter.tenant_slug ? [filter.tenant_slug] : undefined);
  if (requestedTenants) {
    if (!scope?.tenant_slug || !requestedTenants.includes(scope.tenant_slug)) return false;
  }
  if (filter.organization_id && scope?.organization_id !== filter.organization_id) return false;
  if (filter.project_id && scope?.project_id !== filter.project_id) return false;
  if (filter.mission_id && scope?.mission_id !== filter.mission_id.toUpperCase()) return false;
  if (filter.task_id && scope?.task_id !== filter.task_id) return false;
  if (filter.session_id && scope?.session_id !== filter.session_id) return false;
  return true;
}

/** Parse a record scope while distinguishing absent from malformed metadata. */
export function parseEventScopeFromRecord(record: Record<string, unknown>): EventScopeRecordResult {
  const nestedContext = record.scope_context;
  const nestedScope = record.scope;
  if (nestedContext === null || nestedScope === null) {
    return { has_scope: true, invalid: true };
  }
  const nested = nestedContext ?? nestedScope;
  const hasNestedScope = record.scope_context !== undefined || record.scope !== undefined;
  if (hasNestedScope && (!nested || typeof nested !== 'object' || Array.isArray(nested))) {
    return { has_scope: true, invalid: true };
  }
  const comparableKeys = [
    'scope_kind',
    'tier',
    'tenant_slug',
    'tenant_id',
    'organization_id',
    'project_id',
    'mission_id',
    'task_id',
    'session_id',
  ];
  const toRecordOrUndefined = (value: unknown): Record<string, unknown> | undefined =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const nestedContextRecord = toRecordOrUndefined(nestedContext);
  const nestedScopeRecord = toRecordOrUndefined(nestedScope);
  const valuesConflict = (
    left: Record<string, unknown> | undefined,
    right: Record<string, unknown> | undefined
  ): boolean =>
    Boolean(
      left &&
      right &&
      comparableKeys.some(
        (key) =>
          left[key] !== undefined &&
          right[key] !== undefined &&
          String(left[key]) !== String(right[key])
      )
    );
  if (valuesConflict(nestedContextRecord, nestedScopeRecord)) {
    return { has_scope: true, invalid: true };
  }
  const nestedRecord = toRecordOrUndefined(nested);
  if (
    nestedRecord &&
    comparableKeys.some(
      (key) =>
        record[key] !== undefined &&
        nestedRecord[key] !== undefined &&
        String(record[key]) !== String(nestedRecord[key])
    )
  ) {
    return { has_scope: true, invalid: true };
  }
  const source = nestedRecord ? nestedRecord : record;
  const hasScope =
    [
      'scope_kind',
      'tier',
      'tenant_slug',
      'tenant_id',
      'organization_id',
      'project_id',
      'mission_id',
      'task_id',
      'session_id',
    ].some((key) => source[key] !== undefined) ||
    source.tenantSlug !== undefined ||
    source.tenantId !== undefined;
  if (!hasScope) return { has_scope: false, invalid: false };
  try {
    return {
      has_scope: true,
      invalid: false,
      scope: normalizeEventScope({
        ...source,
        ...(source.tenantSlug !== undefined && source.tenant_slug === undefined
          ? { tenant_slug: source.tenantSlug }
          : {}),
        ...(source.tenantId !== undefined && source.tenant_id === undefined
          ? { tenant_id: source.tenantId }
          : {}),
        ...(source.organizationId !== undefined && source.organization_id === undefined
          ? { organization_id: source.organizationId }
          : {}),
        ...(source.projectId !== undefined && source.project_id === undefined
          ? { project_id: source.projectId }
          : {}),
        ...(source.missionId !== undefined && source.mission_id === undefined
          ? { mission_id: source.missionId }
          : {}),
        ...(source.taskId !== undefined && source.task_id === undefined
          ? { task_id: source.taskId }
          : {}),
        ...(source.sessionId !== undefined && source.session_id === undefined
          ? { session_id: source.sessionId }
          : {}),
      } as EventScopeInput),
    };
  } catch {
    return { has_scope: true, invalid: true };
  }
}

/** Read the canonical nested scope, with a flat-field compatibility fallback. */
export function eventScopeFromRecord(record: Record<string, unknown>): EventScope | undefined {
  return parseEventScopeFromRecord(record).scope;
}

/** Serialize one stable nested scope envelope for new records. */
export function serializeEventScope(scope: EventScope): EventScope {
  return normalizeEventScope(scope);
}
