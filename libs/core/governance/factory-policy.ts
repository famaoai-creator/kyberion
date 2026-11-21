import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isValidTenantSlug } from '../entity-scope.js';
import { defineCatalog, type GovernedCatalog } from '../foundation/governed-catalog.js';
import * as pathResolver from '../path-resolver.js';
import { assertSafeRepositoryPath, safeExistsSync } from '../secure-io.js';

export const FACTORY_AUTONOMY_POLICY_REL =
  'knowledge/product/governance/factory-autonomy-policy.json';
export const FACTORY_AUTONOMY_SCHEMA_REL =
  'knowledge/product/schemas/factory-autonomy-policy.schema.json';

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
    const resolved = assertSafeRepositoryPath(
      path.resolve(options.rootDir, FACTORY_AUTONOMY_POLICY_REL),
      { allowMissingLeaf: true }
    );
    return defineCatalog<FactoryAutonomyPolicy>({
      id: 'factory-autonomy-policy',
      path: resolved,
      schema: resolveSchemaPath(options.rootDir),
      fallback: emptyFactoryPolicy,
      fallbackOnInvalid: false,
    }).load();
  }
  return getFactoryAutonomyPolicy();
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
  return cachedCatalog.load();
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
