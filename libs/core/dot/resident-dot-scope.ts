/** Data scope at the existing trusted resident-dot role boundary. */
import { currentExecutionScope } from '../foundation/execution-scope.js';
import { withScopeEnvOnly } from '../foundation/scope-resolution-mode.js';
import {
  currentScopeEnvelope,
  mintScopeEnvelope,
  narrowScopeEnvelope,
  runtimeScopeIdentity,
  withScopeEnvelope,
} from '../scope-envelope.js';
import type { DotCharter } from './dot-charter.js';

export function withResidentDotScope<T>(charter: DotCharter, run: () => T): T {
  if (charter.scope.tier === 'public') {
    const identity = currentScopeEnvelope()?.identity ?? runtimeScopeIdentity();
    if (identity.tier !== 'public')
      throw new Error('Public resident dot cannot inherit an active private envelope');
    return run();
  }
  const scope = charter.scope;
  const caller = currentExecutionScope();
  if (
    !caller ||
    caller.assumedRole !== charter.authority.authority_role ||
    caller.organizationId !== scope.organization_id ||
    (caller.tenantSlug ?? '') !== (scope.tenant_slug ?? '')
  )
    throw new Error('Resident dot data scope requires its verified role and entity binding');
  if (scope.tier === 'personal' && (!scope.owner_nhi || scope.tenant_slug))
    throw new Error('Personal resident scope requires its owner NHI without an invented tenant');
  const identity = {
    tier: scope.tier,
    ...(scope.tenant_slug ? { tenant_slug: scope.tenant_slug } : {}),
    ...(scope.organization_id ? { organization_id: scope.organization_id } : {}),
    ...(scope.project_id ? { project_id: scope.project_id } : {}),
    ...(scope.owner_nhi ? { nhi_id: scope.owner_nhi } : {}),
  };
  const parent = currentScopeEnvelope();
  if (
    parent &&
    (parent.identity.tier !== scope.tier ||
      (parent.identity.tenant_slug ?? '') !== (scope.tenant_slug ?? '') ||
      (scope.owner_nhi && parent.identity.nhi_id && scope.owner_nhi !== parent.identity.nhi_id))
  )
    throw new Error('Resident dot cannot change an active envelope tier or owner');
  const envelope = parent
    ? narrowScopeEnvelope(parent, { identity })
    : withScopeEnvOnly(() =>
        mintScopeEnvelope({
          identity: { ...identity, session_id: `resident-dot:${charter.dot_id}` },
          policy: {
            purpose: 'resident dot execution',
            read_tiers:
              scope.tier === 'personal' ? ['public', 'personal'] : ['public', 'confidential'],
            write_tier: scope.tier,
          },
          env: {
            ...process.env,
            MISSION_ID: '',
            KYBERION_TASK_ID: '',
            KYBERION_TIER: scope.tier,
            KYBERION_TENANT: scope.tenant_slug ?? '',
            KYBERION_ORGANIZATION_ID: scope.organization_id ?? '',
            KYBERION_PROJECT_ID: scope.project_id ?? '',
          },
        })
      );
  return withScopeEnvelope(envelope, run);
}
