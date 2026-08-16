import type { TierLevel } from './types.js';
import { isValidTenantSlug } from './entity-scope.js';

/**
 * The cross-cutting scope envelope for tenant-aware execution.
 *
 * `customer_stance` is intentionally outside the containment chain: it selects
 * an overlay, while `tenant_slug` is the durable confidentiality boundary.
 */
export interface ScopeContext {
  tenant_slug?: string;
  organization_id?: string;
  project_id?: string;
  mission_id?: string;
  task_id?: string;
  session_id?: string;
  work_shape?: string;
  tier: TierLevel;
  customer_stance?: string;
  viewer_principal?: string;
  nhi_id?: string;
}

export interface ScopeContextInput extends Partial<ScopeContext> {
  /** Compatibility input. It is never retained as the canonical field. */
  tenant_id?: string;
}

export interface ScopeContextValidationOptions {
  requireTenant?: boolean;
  requireMission?: boolean;
  allowShared?: boolean;
}

const NON_EMPTY_ID = /^[^\s/]+$/;

function clean(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized ? normalized : undefined;
}

function compatibleAlias(
  tenantSlug: string | undefined,
  tenantId: string | undefined
): string | undefined {
  if (tenantSlug && tenantId && tenantSlug !== tenantId) {
    throw new Error(
      `[SCOPE_CONTEXT_INVALID] tenant_slug '${tenantSlug}' conflicts with compatibility tenant_id '${tenantId}'`
    );
  }
  return tenantSlug || tenantId;
}

/** Normalize aliases and remove empty optional values without widening scope. */
export function normalizeScopeContext(input: ScopeContextInput): ScopeContext {
  const tenantSlug = compatibleAlias(clean(input.tenant_slug), clean(input.tenant_id));
  return {
    ...(tenantSlug ? { tenant_slug: tenantSlug } : {}),
    ...(clean(input.organization_id) ? { organization_id: clean(input.organization_id) } : {}),
    ...(clean(input.project_id) ? { project_id: clean(input.project_id) } : {}),
    ...(clean(input.mission_id) ? { mission_id: clean(input.mission_id) } : {}),
    ...(clean(input.task_id) ? { task_id: clean(input.task_id) } : {}),
    ...(clean(input.session_id) ? { session_id: clean(input.session_id) } : {}),
    ...(clean(input.work_shape) ? { work_shape: clean(input.work_shape) } : {}),
    tier: input.tier as TierLevel,
    ...(clean(input.customer_stance) ? { customer_stance: clean(input.customer_stance) } : {}),
    ...(clean(input.viewer_principal) ? { viewer_principal: clean(input.viewer_principal) } : {}),
    ...(clean(input.nhi_id) ? { nhi_id: clean(input.nhi_id) } : {}),
  };
}

export function validateScopeContext(
  input: ScopeContextInput,
  options: ScopeContextValidationOptions = {}
): string[] {
  const context = normalizeScopeContext(input);
  const errors: string[] = [];
  const requireTenant = options.requireTenant ?? context.tier === 'confidential';

  if (!context.tier || !['personal', 'confidential', 'public'].includes(context.tier)) {
    errors.push('tier is required and must be personal, confidential, or public');
  }
  if (context.tenant_slug && !isValidTenantSlug(context.tenant_slug)) {
    errors.push(`tenant_slug '${context.tenant_slug}' is invalid or reserved`);
  }
  if (requireTenant && !context.tenant_slug) {
    errors.push('tenant_slug is required for this scope');
  }
  if (context.organization_id && !context.tenant_slug && !options.allowShared) {
    errors.push('organization_id requires a tenant_slug');
  }
  if (context.project_id && !context.organization_id) {
    errors.push('project_id requires an organization_id');
  }
  if (context.task_id && !context.mission_id) {
    errors.push('task_id requires a mission_id');
  }
  if (context.session_id && !context.task_id) {
    errors.push('session_id requires a task_id');
  }
  if (options.requireMission && !context.mission_id) errors.push('mission_id is required');
  for (const [key, value] of Object.entries(context)) {
    if (key === 'tier' || key === 'customer_stance' || key === 'tenant_slug') continue;
    if (key === 'nhi_id' || key === 'viewer_principal') continue;
    if (value !== undefined && !NON_EMPTY_ID.test(value)) errors.push(`${key} is invalid`);
  }
  return errors;
}

/** Fail closed before a scope is used for storage, retrieval, or dispatch. */
export function assertScopeContext(
  input: ScopeContextInput,
  options: ScopeContextValidationOptions = {}
): ScopeContext {
  const context = normalizeScopeContext(input);
  const errors = validateScopeContext(context, options);
  if (errors.length > 0) throw new Error(`[SCOPE_CONTEXT_INVALID] ${errors.join('; ')}`);
  return context;
}

/** Resolve runtime hints without ever treating customer stance as tenant scope. */
export function resolveScopeContext(
  input: ScopeContextInput = {},
  env: NodeJS.ProcessEnv = process.env
): ScopeContext {
  return normalizeScopeContext({
    tier: input.tier || (env.KYBERION_TIER as TierLevel | undefined),
    tenant_slug: input.tenant_slug || env.KYBERION_TENANT,
    tenant_id: input.tenant_id,
    organization_id: input.organization_id || env.KYBERION_ORGANIZATION_ID,
    project_id: input.project_id || env.KYBERION_PROJECT_ID,
    mission_id: input.mission_id || env.MISSION_ID,
    task_id: input.task_id || env.KYBERION_TASK_ID,
    session_id: input.session_id,
    work_shape: input.work_shape,
    customer_stance: input.customer_stance || env.KYBERION_CUSTOMER,
    viewer_principal: input.viewer_principal || env.KYBERION_VIEWER_PRINCIPAL,
    nhi_id: input.nhi_id || env.KYBERION_NHI_ACTOR,
  });
}

let cachedCurrentScope: ScopeContext | undefined;

/** Resolve the process scope once for the current CLI/runtime session. */
export function currentScope(
  input: ScopeContextInput = {},
  env: NodeJS.ProcessEnv = process.env
): ScopeContext {
  if (Object.keys(input).length === 0 && env === process.env && cachedCurrentScope) {
    return cachedCurrentScope;
  }
  const resolved = resolveScopeContext(input, env);
  const scope = assertScopeContext(
    { ...resolved, tier: resolved.tier || 'public' },
    { requireTenant: false, allowShared: true }
  );
  if (Object.keys(input).length === 0 && env === process.env) cachedCurrentScope = scope;
  return scope;
}

export function resetCurrentScope(): void {
  cachedCurrentScope = undefined;
}

export function scopeContextKey(context: ScopeContext): string {
  const normalized = assertScopeContext(context, { requireTenant: false });
  return [
    normalized.tenant_slug || 'shared',
    normalized.organization_id || '_',
    normalized.project_id || '_',
    normalized.mission_id || '_',
    normalized.task_id || '_',
    normalized.session_id || '_',
    normalized.tier,
  ].join('/');
}
