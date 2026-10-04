/**
 * Shared plumbing for the scheduled organization cadences (DL-06): sovereign
 * gate, organization discovery across tenants, and the governed operation tick
 * sweep. Kept apart from `organization-operation-tick.ts` so that module stays
 * a light, injectable core.
 */
import * as path from 'node:path';
import { auditChain } from '../governance/audit-chain.js';
import { getRegisteredEnvText } from '../foundation/env.js';
import { currentExecutionScope, executionPersonaText } from '../foundation/execution-scope.js';
import { isReservedScopeName, isValidTenantSlug } from '../entity-scope.js';
import { pathResolver } from '../path-resolver.js';
import { safeExistsSync, safeReaddir, safeStat } from '../secure-io.js';
import { listOrganizationOperationalStates } from './organization-operating-model-management.js';
import type { OrganizationTier } from './organization-operating-model.js';
import {
  tickDueOrganizationOperations,
  type OrganizationScopeRef,
  type TickDeps,
  type TickOptions,
  type TickReport,
} from './organization-operation-tick.js';

function listDirectories(dir: string): string[] {
  if (!safeExistsSync(dir)) return [];
  return safeReaddir(dir)
    .filter((entry) => !entry.startsWith('.'))
    .filter((entry) => safeStat(path.join(dir, entry)).isDirectory())
    .sort();
}

/**
 * The tenant of a discovered organization scope. Directory partitions such as
 * `shared` (untenanted organizations) and every other reserved scope name are
 * never tenants (RESERVED_SCOPE_NAMES), so they normalise to `undefined`. The
 * single rule every cadence (tick, standup, retro) applies before persisting
 * or binding a `tenant_slug`.
 */
export function normalizeCadenceTenant(tenantSlug: string | undefined): string | undefined {
  const trimmed = tenantSlug?.trim();
  return !trimmed || isReservedScopeName(trimmed) ? undefined : trimmed;
}

/**
 * Organizations under one tier (optionally one tenant / one organization).
 * `tenantSlug` on each ref is normalised: untenanted organizations carry none.
 */
export function listOrganizationScopes(
  scope: Pick<TickOptions, 'tier' | 'tenantSlug' | 'organizationId'>,
  rootDir: string = pathResolver.rootDir()
): OrganizationScopeRef[] {
  const tenants = scope.tenantSlug
    ? [scope.tenantSlug]
    : listDirectories(path.join(rootDir, 'active/organizations', scope.tier));
  const refs: OrganizationScopeRef[] = [];
  for (const tenantSlug of tenants) {
    if (tenantSlug !== 'shared' && !isValidTenantSlug(tenantSlug)) continue;
    let states;
    try {
      states = listOrganizationOperationalStates({
        tier: scope.tier,
        tenantSlug,
        rootDir,
        ...(scope.organizationId ? { organizationId: scope.organizationId } : {}),
      });
    } catch {
      continue; // one unreadable tenant must not stop the others
    }
    for (const state of states) {
      if (state.status === 'archived') continue;
      const tenant = normalizeCadenceTenant(tenantSlug);
      refs.push({
        organizationId: state.organization_id,
        tier: scope.tier,
        ...(tenant ? { tenantSlug: tenant } : {}),
        name: state.name,
      });
    }
  }
  return refs;
}

/** Cross-tenant cadences are sovereign-only (same rule as the organization digest). */
export function assertSovereignCadencePersona(
  what: string,
  env?: Record<string, string | undefined>
): string {
  const persona = env ? getRegisteredEnvText('KYBERION_PERSONA', { env }) : executionPersonaText();
  if (persona !== 'sovereign') {
    throw new Error(
      `[POLICY_VIOLATION] The organization ${what} aggregates across tenants and requires KYBERION_PERSONA=sovereign (got ${persona || 'unset'}).`
    );
  }
  return persona;
}

/**
 * One organization a scoped cadence runs for — the per-tenant path the resident
 * dot sweep uses (as `organization_operator`) instead of the sovereign
 * cross-tenant sweep.
 */
export interface OrganizationCadenceScope {
  tier: OrganizationTier;
  /** Absent for an untenanted organization (the `shared` partition). */
  tenantSlug?: string;
  organizationId: string;
}

/**
 * Scoped cadences need no sovereign persona, but must run inside a governed
 * execution scope whose bound tenant equals the cadence tenant (and whose
 * bound organization, when one is bound, equals the cadence organization).
 * Returns the assumed role, used as the audit agent id.
 */
export function assertScopedCadenceExecution(
  what: string,
  scope: OrganizationCadenceScope
): string {
  if (!scope.organizationId?.trim()) {
    throw new Error(
      `[POLICY_VIOLATION] A scoped organization ${what} requires an organization id.`
    );
  }
  const execution = currentExecutionScope();
  const role = execution?.assumedRole?.trim();
  if (!execution || !role) {
    throw new Error(
      `[POLICY_VIOLATION] A scoped organization ${what} must run inside a governed execution scope bound to its tenant (withExecutionContextAsync).`
    );
  }
  const expected = normalizeCadenceTenant(scope.tenantSlug);
  const bound = normalizeCadenceTenant(execution.tenantBound ? execution.tenantSlug : undefined);
  if (bound !== expected) {
    throw new Error(
      `[POLICY_VIOLATION] The scoped organization ${what} for tenant '${expected || '(none)'}' cannot run in an execution scope bound to tenant '${bound || '(none)'}'.`
    );
  }
  if (execution.organizationId && execution.organizationId !== scope.organizationId) {
    throw new Error(
      `[POLICY_VIOLATION] The scoped organization ${what} for organization '${scope.organizationId}' cannot run in an execution scope bound to organization '${execution.organizationId}'.`
    );
  }
  return role;
}

/** Authorization for one cadence run: scoped (bound tenant) or cross-tenant (sovereign). */
export interface CadenceAuthorization {
  agentId: string;
  mode: 'scoped' | 'cross_tenant';
  tenantSlug?: string;
}

export function authorizeOrganizationCadence(
  what: string,
  scope: OrganizationCadenceScope | undefined,
  env?: Record<string, string | undefined>
): CadenceAuthorization {
  if (!scope) return { agentId: assertSovereignCadencePersona(what, env), mode: 'cross_tenant' };
  const tenant = normalizeCadenceTenant(scope.tenantSlug);
  return {
    agentId: assertScopedCadenceExecution(what, scope),
    mode: 'scoped',
    ...(tenant ? { tenantSlug: tenant } : {}),
  };
}

function inCadenceScope(ref: OrganizationScopeRef, scope: OrganizationCadenceScope): boolean {
  return (
    ref.organizationId === scope.organizationId &&
    ref.tier === scope.tier &&
    normalizeCadenceTenant(ref.tenantSlug) === normalizeCadenceTenant(scope.tenantSlug)
  );
}

/**
 * Organizations one cadence covers under `tier`: every organization when
 * unscoped, otherwise only the scoped organization (discovery results are
 * filtered, so an injected lister can never widen a scoped run).
 */
export function cadenceOrganizations(
  tier: OrganizationTier,
  scope: OrganizationCadenceScope | undefined,
  rootDir?: string,
  list?: (tier: OrganizationTier) => OrganizationScopeRef[]
): OrganizationScopeRef[] {
  if (!scope) return list?.(tier) ?? listOrganizationScopes({ tier }, rootDir);
  if (tier !== scope.tier) return [];
  const refs =
    list?.(tier) ??
    listOrganizationScopes(
      {
        tier,
        tenantSlug: normalizeCadenceTenant(scope.tenantSlug) ?? 'shared',
        organizationId: scope.organizationId,
      },
      rootDir
    );
  return refs.filter((ref) => inCadenceScope(ref, scope));
}

export interface OrganizationOperationTickRunOptions {
  /** Scoped mode: tick only this organization (no sovereign persona; bound tenant must match). */
  scope?: OrganizationCadenceScope;
  tiers?: OrganizationTier[];
  apply: boolean;
  now?: Date;
  rootDir?: string;
  env?: Record<string, string | undefined>;
}

/**
 * Governed sweep: sovereign-only across tenants, or scoped to one organization
 * (`options.scope`) inside an execution scope bound to its tenant. Audited.
 */
export async function runOrganizationOperationTick(
  options: OrganizationOperationTickRunOptions,
  deps: Pick<TickDeps, 'executeOperation'> & Partial<TickDeps>
): Promise<TickReport> {
  const auth = authorizeOrganizationCadence('operation tick', options.scope, options.env);
  const scoped = options.scope;
  const tiers = scoped ? [scoped.tier] : (options.tiers ?? ['confidential', 'public']);
  const list = deps.listOrganizations;
  const tickDeps: TickDeps = {
    ...deps,
    listOrganizations: scoped
      ? (query) =>
          cadenceOrganizations(
            query.tier,
            scoped,
            options.rootDir,
            list ? () => list(query) : undefined
          )
      : (list ?? ((query) => listOrganizationScopes(query, options.rootDir))),
  };
  const result: TickReport = {
    mode: options.apply ? 'apply' : 'dry_run',
    organizations: 0,
    due: [],
    blocked: [],
    incomplete_runs: [],
    due_count: 0,
    run_count: 0,
    recovered: [],
    active: [],
    failures: [],
  };
  for (const tier of tiers) {
    const report = await tickDueOrganizationOperations(
      { tier, apply: options.apply, now: options.now },
      tickDeps
    );
    result.organizations += report.organizations;
    result.due.push(...report.due);
    result.blocked.push(...report.blocked);
    result.incomplete_runs.push(...report.incomplete_runs);
    result.recovered.push(...report.recovered);
    result.active.push(...report.active);
    result.failures.push(...report.failures);
    result.due_count += report.due_count;
    result.run_count += report.run_count;
  }
  auditChain.record({
    agentId: auth.agentId,
    action: 'organization.operation_tick',
    operation: `tick:${auth.mode}`,
    result: result.failures.length ? 'failed' : 'completed',
    ...(auth.tenantSlug ? { tenantSlug: auth.tenantSlug } : {}),
    metadata: {
      tiers,
      ...(scoped ? { organization_id: scoped.organizationId } : {}),
      mode: result.mode,
      organizations: result.organizations,
      due_count: result.due_count,
      run_count: result.run_count,
      recovered: result.recovered.length,
      failures: result.failures.length,
    },
  });
  return result;
}
