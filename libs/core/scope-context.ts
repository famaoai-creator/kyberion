import type { TierLevel } from './types.js';
import { isValidTenantSlug } from './entity-scope.js';
import { pathResolver } from './path-resolver.js';
import {
  loadJson,
  safeExistsSync,
  safeReadFile,
  safeExec,
  safeUnlinkSync,
  safeWriteFile,
} from './secure-io.js';

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

export type ScopeValueProvenance =
  'explicit' | 'env' | 'scope.env' | 'mission-state' | 'cwd' | 'git' | 'default';

export interface ScopeResolution {
  scope: ScopeContext;
  provenance: Partial<Record<keyof ScopeContext, ScopeValueProvenance>>;
  knowledge_roots: string[];
}

export interface ScopeResolutionOptions {
  includePersisted?: boolean;
  inferFromMission?: boolean;
  inferFromCwd?: boolean;
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
const SCOPE_ENV_KEYS = [
  'KYBERION_TIER',
  'KYBERION_TENANT',
  'KYBERION_ORGANIZATION_ID',
  'KYBERION_PROJECT_ID',
  'MISSION_ID',
  'KYBERION_TASK_ID',
] as const;

function scopeEnvPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.KYBERION_SCOPE_ENV_PATH?.trim() || pathResolver.shared('runtime/scope.env');
}

function readScopeEnv(env: NodeJS.ProcessEnv = process.env): ScopeContextInput {
  const filePath = scopeEnvPath(env);
  if (!safeExistsSync(filePath)) return {};
  try {
    const values: Record<string, string> = {};
    for (const line of String(safeReadFile(filePath, { encoding: 'utf8' })).split(/\r?\n/)) {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (match && SCOPE_ENV_KEYS.includes(match[1] as (typeof SCOPE_ENV_KEYS)[number])) {
        values[match[1]] = match[2].trim();
      }
    }
    return {
      tier: values.KYBERION_TIER as TierLevel | undefined,
      tenant_slug: values.KYBERION_TENANT,
      organization_id: values.KYBERION_ORGANIZATION_ID,
      project_id: values.KYBERION_PROJECT_ID,
      mission_id: values.MISSION_ID,
      task_id: values.KYBERION_TASK_ID,
    };
  } catch {
    return {};
  }
}

function readMissionScope(missionId: string): ScopeContextInput {
  try {
    const missionPath = pathResolver.findMissionPath(missionId);
    if (!missionPath) return {};
    const state = loadJson<{
      tier?: unknown;
      tenant_slug?: unknown;
      tenant_id?: unknown;
      organization_id?: unknown;
      relationships?: { project?: { project_id?: unknown } };
    }>(pathResolver.rootResolve(`${pathResolver.toRepoRelative(missionPath)}/mission-state.json`));
    return {
      tier: state.tier as TierLevel | undefined,
      tenant_slug:
        typeof state.tenant_slug === 'string'
          ? state.tenant_slug
          : typeof state.tenant_id === 'string'
            ? state.tenant_id
            : undefined,
      organization_id:
        typeof state.organization_id === 'string' ? state.organization_id : undefined,
      project_id:
        typeof state.relationships?.project?.project_id === 'string'
          ? state.relationships.project.project_id
          : undefined,
    };
  } catch {
    return {};
  }
}

function inferFromCwd(): ScopeContextInput {
  const cwd = process.cwd();
  const normalized = cwd.replace(/\\/g, '/');
  const match = normalized.match(
    /(?:knowledge|active\/[^/]+)\/(?:confidential|personal)\/([a-z0-9][a-z0-9-]*)/i
  );
  const tenant = match?.[1]?.toLowerCase();
  return tenant && isValidTenantSlug(tenant) ? { tenant_slug: tenant } : {};
}

function inferFromGit(): ScopeContextInput {
  try {
    const configured = safeExec('git', ['config', '--get', 'kyberion.tenant'], {
      cwd: pathResolver.rootDir(),
      timeoutMs: 2_000,
    })
      .trim()
      .toLowerCase();
    return configured && isValidTenantSlug(configured) ? { tenant_slug: configured } : {};
  } catch {
    return {};
  }
}

function knowledgeRoots(scope: ScopeContext): string[] {
  const roots = ['public', 'product'];
  const tenant = scope.tenant_slug;
  const chain = [
    ['organizations', scope.organization_id],
    ['projects', scope.project_id],
    ['missions', scope.mission_id],
    ['tasks', scope.task_id],
    ['sessions', scope.session_id],
  ] as const;
  const entity = (tier: 'confidential' | 'personal') => {
    if (!tenant) return undefined;
    const parts = [tier, tenant];
    for (const [directory, value] of chain) {
      if (!value) break;
      parts.push(directory, value);
    }
    return parts.join('/');
  };
  if (scope.tier === 'confidential') {
    const root = entity('confidential');
    if (root) roots.push(root);
    roots.push('confidential/common');
  } else if (scope.tier === 'personal') {
    const root = entity('personal');
    if (root) roots.push(root);
  }
  return [...new Set(roots)];
}

function mergeScopeSources(
  input: ScopeContextInput,
  env: NodeJS.ProcessEnv,
  options: ScopeResolutionOptions
): { values: ScopeContextInput; provenance: ScopeResolution['provenance'] } {
  const persisted = options.includePersisted === false ? {} : readScopeEnv(env);
  const envValues: ScopeContextInput = {
    tier: env.KYBERION_TIER as TierLevel | undefined,
    tenant_slug: env.KYBERION_TENANT,
    organization_id: env.KYBERION_ORGANIZATION_ID,
    project_id: env.KYBERION_PROJECT_ID,
    mission_id: env.MISSION_ID,
    task_id: env.KYBERION_TASK_ID,
  };
  const mission =
    options.inferFromMission === false
      ? {}
      : readMissionScope(
          clean(input.mission_id) || clean(env.MISSION_ID) || clean(persisted.mission_id) || ''
        );
  const inferred = options.inferFromCwd === false ? {} : inferFromCwd();
  const gitInferred = options.inferFromCwd === false ? {} : inferFromGit();
  const defaults: ScopeContextInput = { tier: 'public' };
  const fields = [
    'tier',
    'tenant_slug',
    'organization_id',
    'project_id',
    'mission_id',
    'task_id',
  ] as const;
  const values: ScopeContextInput = { ...defaults };
  for (const source of [persisted, envValues, input]) {
    for (const [key, value] of Object.entries(source)) {
      if (clean(value) !== undefined) values[key as keyof ScopeContextInput] = value as never;
    }
  }
  const provenance: ScopeResolution['provenance'] = {};
  for (const field of fields) {
    let value = clean(values[field]);
    provenance[field] = clean(input[field])
      ? 'explicit'
      : clean(envValues[field])
        ? 'env'
        : clean(persisted[field])
          ? 'scope.env'
          : clean(mission[field])
            ? 'mission-state'
            : clean(inferred[field])
              ? field === 'tenant_slug'
                ? 'cwd'
                : 'git'
              : clean(gitInferred[field])
                ? 'git'
                : 'default';
    if (!value && clean(mission[field])) {
      values[field] = mission[field] as never;
      value = clean(mission[field]);
    }
    if (!value && clean(inferred[field])) {
      values[field] = inferred[field] as never;
      value = clean(inferred[field]);
    }
    if (!value && clean(gitInferred[field])) {
      values[field] = gitInferred[field] as never;
      value = clean(gitInferred[field]);
    }
    if (!clean(input[field]) && !clean(envValues[field]) && !clean(persisted[field])) {
      provenance[field] = clean(mission[field])
        ? 'mission-state'
        : clean(inferred[field])
          ? field === 'tenant_slug'
            ? 'cwd'
            : 'git'
          : clean(gitInferred[field])
            ? 'git'
            : field === 'tier'
              ? 'default'
              : provenance[field];
    }
  }
  return { values, provenance };
}

export function resolveScopeResolution(
  input: ScopeContextInput = {},
  env: NodeJS.ProcessEnv = process.env,
  options: ScopeResolutionOptions = {}
): ScopeResolution {
  const { values, provenance } = mergeScopeSources(input, env, options);
  const scope = normalizeScopeContext({
    ...values,
    customer_stance: input.customer_stance || env.KYBERION_CUSTOMER,
    viewer_principal: input.viewer_principal || env.KYBERION_VIEWER_PRINCIPAL,
    nhi_id: input.nhi_id || env.KYBERION_NHI_ACTOR,
  });
  return { scope, provenance, knowledge_roots: knowledgeRoots(scope) };
}

export function resolveScopeContext(
  input: ScopeContextInput = {},
  env: NodeJS.ProcessEnv = process.env
): ScopeContext {
  return resolveScopeResolution(input, env).scope;
}

export function writeScopeEnv(
  input: ScopeContextInput,
  env: NodeJS.ProcessEnv = process.env
): string {
  const scope = assertScopeContext(
    { ...input, tier: input.tier || 'public' },
    { requireTenant: false, allowShared: true }
  );
  const lines = [
    '# Generated by `pnpm scope use`; edit with the governed scope CLI.',
    `KYBERION_TIER=${scope.tier}`,
    `KYBERION_TENANT=${scope.tenant_slug || ''}`,
    `KYBERION_ORGANIZATION_ID=${scope.organization_id || ''}`,
    `KYBERION_PROJECT_ID=${scope.project_id || ''}`,
    `MISSION_ID=${scope.mission_id || ''}`,
    `KYBERION_TASK_ID=${scope.task_id || ''}`,
    '',
  ].join('\n');
  const filePath = scopeEnvPath(env);
  safeWriteFile(filePath, lines, { encoding: 'utf8', mkdir: true, mode: 0o600 });
  return filePath;
}

export function clearScopeEnv(env: NodeJS.ProcessEnv = process.env): void {
  const filePath = scopeEnvPath(env);
  if (safeExistsSync(filePath)) safeUnlinkSync(filePath);
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
