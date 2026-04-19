import AjvModule, { type ValidateFunction } from 'ajv';
import { compileSchemaFromPath } from './schema-loader.js';
import { pathResolver } from './path-resolver.js';
import { safeReadFile } from './secure-io.js';
import type { MissionTeamAssignment } from './mission-team-composer.js';

type UnknownScopeBehavior = 'allow_with_warning' | 'block';

interface PathScopePolicyFile {
  version: string;
  defaults: {
    unknown_scope_behavior: UnknownScopeBehavior;
  };
  scope_classes: Record<string, {
    allow_prefixes: string[];
    description?: string;
  }>;
}

export interface DelegatedTaskEnvelope {
  task_id: string;
  team_role: string;
  deliverable?: string;
  target_path?: string;
}

export interface DelegationPreflightResult {
  allowed: boolean;
  reason: string;
  target_path?: string;
  target_scope_class?: string;
  warnings: string[];
}

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });
const PATH_SCOPE_POLICY_SCHEMA_PATH = pathResolver.knowledge('public/schemas/path-scope-policy.schema.json');
const PATH_SCOPE_POLICY_PATH = pathResolver.knowledge('public/governance/path-scope-policy.json');

let pathScopePolicyValidateFn: ValidateFunction | null = null;

function ensurePathScopePolicyValidator(): ValidateFunction {
  if (pathScopePolicyValidateFn) return pathScopePolicyValidateFn;
  pathScopePolicyValidateFn = compileSchemaFromPath(ajv, PATH_SCOPE_POLICY_SCHEMA_PATH);
  return pathScopePolicyValidateFn;
}

function normalizePath(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/^\.\/+/, '').toLowerCase();
}

function loadPathScopePolicy(): PathScopePolicyFile {
  const parsed = JSON.parse(safeReadFile(PATH_SCOPE_POLICY_PATH, { encoding: 'utf8' }) as string) as PathScopePolicyFile;
  const validate = ensurePathScopePolicyValidator();
  if (!validate(parsed)) {
    const errors = (validate.errors || []).map((error) => `${error.instancePath || '/'} ${error.message || 'schema violation'}`).join('; ');
    throw new Error(`Invalid path-scope-policy: ${errors}`);
  }
  return parsed;
}

export function inferTaskTargetPath(task: { target_path?: string; deliverable?: string }): string | undefined {
  if (typeof task.target_path === 'string' && task.target_path.trim()) return task.target_path.trim();
  const deliverable = typeof task.deliverable === 'string' ? task.deliverable.trim() : '';
  if (!deliverable) return undefined;
  if (deliverable.includes('/') && !/\s/.test(deliverable)) {
    return deliverable;
  }
  return undefined;
}

function resolveScopeClass(targetPath: string, policy: PathScopePolicyFile): string | undefined {
  const normalized = normalizePath(targetPath);
  for (const [scopeClass, config] of Object.entries(policy.scope_classes || {})) {
    const matched = (config.allow_prefixes || [])
      .map((prefix) => normalizePath(prefix))
      .some((prefix) => normalized.startsWith(prefix));
    if (matched) return scopeClass;
  }
  return undefined;
}

function pathAllowedByAssignment(targetPath: string, assignment: MissionTeamAssignment): boolean {
  const allowedScopes = assignment.delegation_contract?.allowed_write_scopes || [];
  if (!allowedScopes.length) return true;
  const normalizedTarget = normalizePath(targetPath);
  return allowedScopes
    .map((scope) => normalizePath(scope))
    .some((scope) => normalizedTarget.startsWith(scope));
}

export function validateDelegatedTaskPreflight(input: {
  task: DelegatedTaskEnvelope;
  assignment: MissionTeamAssignment;
}): DelegationPreflightResult {
  const warnings: string[] = [];
  const policy = loadPathScopePolicy();
  const targetPath = inferTaskTargetPath(input.task);

  if (!targetPath) {
    warnings.push('No explicit target_path found; path-scope checks were skipped.');
    return {
      allowed: true,
      reason: 'No target path declared in delegated task.',
      warnings,
    };
  }

  if (!pathAllowedByAssignment(targetPath, input.assignment)) {
    return {
      allowed: false,
      reason: `Target path '${targetPath}' is outside assignment allowed_write_scopes.`,
      target_path: targetPath,
      warnings,
    };
  }

  const targetScopeClass = resolveScopeClass(targetPath, policy);
  if (!targetScopeClass) {
    if (policy.defaults.unknown_scope_behavior === 'block') {
      return {
        allowed: false,
        reason: `Target path '${targetPath}' does not match any known path scope class.`,
        target_path: targetPath,
        warnings,
      };
    }
    warnings.push(`Target path '${targetPath}' matched no known scope class.`);
    return {
      allowed: true,
      reason: 'Target path allowed with warning due to unknown scope classification.',
      target_path: targetPath,
      warnings,
    };
  }

  const resolvedScopes = new Set(input.assignment.delegation_contract?.resolved_scope_classes || []);
  if (resolvedScopes.size && !resolvedScopes.has(targetScopeClass)) {
    return {
      allowed: false,
      reason: `Target scope class '${targetScopeClass}' is not permitted for assignment scope classes.`,
      target_path: targetPath,
      target_scope_class: targetScopeClass,
      warnings,
    };
  }

  return {
    allowed: true,
    reason: 'Delegation preflight passed for target path and scope class.',
    target_path: targetPath,
    target_scope_class: targetScopeClass,
    warnings,
  };
}
