import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isValidTenantSlug } from '../entity-scope.js';
import { defineCatalog, type GovernedCatalog } from '../foundation/governed-catalog.js';
import { createLogger } from '../logger.js';
import {
  readTenantGovernanceOverlays,
  type TenantGovernanceOverlay,
} from '../organization/tenant-governance-overlay.js';
import * as pathResolver from '../path-resolver.js';
import { assertSafeRepositoryPath, safeExistsSync } from '../secure-io.js';

const logger = createLogger('factory-policy');

export const FACTORY_AUTONOMY_POLICY_REL =
  'knowledge/product/governance/factory-autonomy-policy.json';
export const FACTORY_AUTONOMY_SCHEMA_REL =
  'knowledge/product/schemas/factory-autonomy-policy.schema.json';
export const TENANT_FACTORY_POLICY_OVERLAY_FILE = 'factory-autonomy-policy.json';

export const FACTORY_GRADUATABLE_ACTIONS = [
  'mission_start_mandate',
  'ci_autofix_attempt',
  'main_sync_clean',
  'conflict_mechanical',
  'pr_merge_low',
  'pr_merge_medium',
  'auto_revert_on_main_failure',
] as const;

export type FactoryGraduatableActionId = (typeof FACTORY_GRADUATABLE_ACTIONS)[number];

export interface FactoryTenantAutonomyConfig {
  enabled: boolean;
  graduated_actions: FactoryGraduatableActionId[];
  max_parallel_missions?: number;
  default_branch_prefix?: 'agent/factory-';
  approved_by?: string;
  approved_at?: string;
  notes?: string;
}

export interface FactoryAutonomyPolicy {
  version: string;
  description?: string;
  tenants: Record<string, FactoryTenantAutonomyConfig>;
}

export interface FactoryPolicyLoadOptions {
  policyPath?: string;
  rootDir?: string;
  /** Merge confidential tenant overlays under knowledge/confidential/<slug>/governance/ (default true except with explicit policyPath). */
  tenantOverlays?: boolean;
}

const DEFAULT_EMPTY_FACTORY_POLICY: FactoryAutonomyPolicy = {
  version: 'default-empty',
  tenants: {},
};

const GRADUATABLE_SET = new Set<string>(FACTORY_GRADUATABLE_ACTIONS);

let cachedCatalog: GovernedCatalog<FactoryAutonomyPolicy> | undefined;
let cachedRootDir: string | undefined;

function emptyFactoryPolicy(): FactoryAutonomyPolicy {
  return {
    version: DEFAULT_EMPTY_FACTORY_POLICY.version,
    tenants: {},
  };
}

function resolveSchemaPath(rootDir?: string): string {
  const candidates = [
    ...(rootDir ? [path.resolve(rootDir, FACTORY_AUTONOMY_SCHEMA_REL)] : []),
    pathResolver.rootResolve(FACTORY_AUTONOMY_SCHEMA_REL),
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../',
      FACTORY_AUTONOMY_SCHEMA_REL
    ),
  ];
  for (const candidate of candidates) {
    if (safeExistsSync(candidate)) return candidate;
  }
  return candidates[0];
}

/**
 * Merge confidential tenant governance overlays into the base factory policy.
 * Each overlay is validated against the canonical schema and strictly scoped to
 * its directory tenant; invalid overlays or foreign tenant keys are dropped with
 * a warning rather than affecting other tenants.
 */
export function mergeTenantFactoryAutonomyOverlays(
  base: FactoryAutonomyPolicy,
  overlays: readonly TenantGovernanceOverlay[],
  schemaPath?: string
): FactoryAutonomyPolicy {
  const resolvedSchemaPath = schemaPath ?? resolveSchemaPath();
  const validator = defineCatalog<FactoryAutonomyPolicy>({
    id: 'factory-autonomy-policy',
    path: resolvedSchemaPath,
    schema: resolvedSchemaPath,
  });
  const tenants: Record<string, FactoryTenantAutonomyConfig> = { ...base.tenants };
  for (const overlay of overlays) {
    if (!isValidTenantSlug(overlay.tenant_slug)) {
      logger.warn(
        `tenant overlay ignored — invalid tenant slug '${overlay.tenant_slug}' | next: use a valid tenant slug directory | evidence: ${overlay.path}`
      );
      continue;
    }
    try {
      if (overlay.error) throw new Error(overlay.error);
      const value = overlay.value;
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('overlay must be a JSON object');
      }
      const validated = validator.validate(value, overlay.path);
      for (const key of Object.keys(validated.tenants)) {
        if (key !== overlay.tenant_slug) {
          logger.warn(
            `tenant ${overlay.tenant_slug} factory autonomy overlay ignored foreign tenant '${key}' — overlay scope is restricted to '${overlay.tenant_slug}' | next: remove '${key}' from ${overlay.path} | evidence: ${overlay.path}`
          );
        }
      }
      if (Object.hasOwn(validated.tenants, overlay.tenant_slug)) {
        tenants[overlay.tenant_slug] = validated.tenants[overlay.tenant_slug]!;
      }
    } catch (error) {
      logger.warn(
        `tenant ${overlay.tenant_slug} factory autonomy overlay ignored — invalid file | next: fix ${overlay.path} | evidence: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  return { ...base, tenants };
}

export function loadFactoryAutonomyPolicy(
  options: FactoryPolicyLoadOptions = {}
): FactoryAutonomyPolicy {
  if (options.policyPath !== undefined) {
    const resolved = assertSafeRepositoryPath(options.policyPath, { allowMissingLeaf: true });
    return defineCatalog<FactoryAutonomyPolicy>({
      id: 'factory-autonomy-policy',
      path: resolved,
      schema: resolveSchemaPath(options.rootDir),
    }).load();
  }
  if (options.rootDir !== undefined) {
    const schema = resolveSchemaPath(options.rootDir);
    const resolved = assertSafeRepositoryPath(
      path.resolve(options.rootDir, FACTORY_AUTONOMY_POLICY_REL),
      { allowMissingLeaf: true }
    );
    const base = defineCatalog<FactoryAutonomyPolicy>({
      id: 'factory-autonomy-policy',
      path: resolved,
      schema,
      fallback: emptyFactoryPolicy,
      fallbackOnInvalid: false,
    }).load();
    if (options.tenantOverlays === false) return base;
    return mergeTenantFactoryAutonomyOverlays(
      base,
      readTenantGovernanceOverlays(TENANT_FACTORY_POLICY_OVERLAY_FILE, {
        rootDir: options.rootDir,
      }),
      schema
    );
  }
  return getFactoryAutonomyPolicy(options);
}

export function getFactoryAutonomyPolicy(
  options?: FactoryPolicyLoadOptions
): FactoryAutonomyPolicy {
  if (options?.policyPath !== undefined || options?.rootDir !== undefined) {
    return loadFactoryAutonomyPolicy(options);
  }
  const currentRoot = pathResolver.rootDir();
  if (!cachedCatalog || cachedRootDir !== currentRoot) {
    cachedCatalog = defineCatalog<FactoryAutonomyPolicy>({
      id: 'factory-autonomy-policy',
      path: () => pathResolver.rootResolve(FACTORY_AUTONOMY_POLICY_REL),
      schema: resolveSchemaPath(currentRoot),
      fallback: emptyFactoryPolicy,
      fallbackOnInvalid: false,
    });
    cachedRootDir = currentRoot;
  }
  const base = cachedCatalog.load();
  if (options?.tenantOverlays === false) return base;
  return mergeTenantFactoryAutonomyOverlays(
    base,
    readTenantGovernanceOverlays(TENANT_FACTORY_POLICY_OVERLAY_FILE, { rootDir: currentRoot }),
    resolveSchemaPath(currentRoot)
  );
}

export function getTenantFactoryAutonomyConfig(
  tenantSlug: string | undefined,
  policy?: FactoryAutonomyPolicy
): FactoryTenantAutonomyConfig | undefined {
  if (!tenantSlug || !isValidTenantSlug(tenantSlug)) return undefined;
  const resolved = policy ?? getFactoryAutonomyPolicy();
  if (!Object.hasOwn(resolved.tenants, tenantSlug)) return undefined;
  return resolved.tenants[tenantSlug];
}

export function isFactoryActionGraduated(
  actionId: string,
  tenantSlug?: string,
  policy?: FactoryAutonomyPolicy
): boolean {
  if (!tenantSlug || !isValidTenantSlug(tenantSlug)) return false;
  if (!GRADUATABLE_SET.has(actionId)) return false;
  try {
    const config = getTenantFactoryAutonomyConfig(tenantSlug, policy);
    if (!config || config.enabled !== true) return false;
    return config.graduated_actions.includes(actionId as FactoryGraduatableActionId);
  } catch {
    return false;
  }
}

export function _resetFactoryAutonomyPolicyCacheForTests(): void {
  cachedCatalog?.reset();
  cachedCatalog = undefined;
  cachedRootDir = undefined;
}
