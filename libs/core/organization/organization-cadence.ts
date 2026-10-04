/**
 * Shared plumbing for the scheduled organization cadences (DL-06): sovereign
 * gate, organization discovery across tenants, and the governed operation tick
 * sweep. Kept apart from `organization-operation-tick.ts` so that module stays
 * a light, injectable core.
 */
import * as path from 'node:path';
import { auditChain } from '../governance/audit-chain.js';
import { getRegisteredEnvText } from '../foundation/env.js';
import { executionPersonaText } from '../foundation/execution-scope.js';
import { isValidTenantSlug } from '../entity-scope.js';
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

/** Organizations under one tier (optionally one tenant / one organization). */
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
      refs.push({
        organizationId: state.organization_id,
        tier: scope.tier,
        tenantSlug,
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

export interface OrganizationOperationTickRunOptions {
  tiers?: OrganizationTier[];
  apply: boolean;
  now?: Date;
  rootDir?: string;
  env?: Record<string, string | undefined>;
}

/** Governed sweep used by the scheduled op: sovereign-only, audited. */
export async function runOrganizationOperationTick(
  options: OrganizationOperationTickRunOptions,
  deps: Pick<TickDeps, 'executeOperation'> & Partial<TickDeps>
): Promise<TickReport> {
  const persona = assertSovereignCadencePersona('operation tick', options.env);
  const tiers = options.tiers ?? ['confidential', 'public'];
  const tickDeps: TickDeps = {
    listOrganizations: (scope) => listOrganizationScopes(scope, options.rootDir),
    ...deps,
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
    agentId: persona,
    action: 'organization.operation_tick',
    operation: 'tick:cross_tenant',
    result: result.failures.length ? 'failed' : 'completed',
    metadata: {
      tiers,
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
