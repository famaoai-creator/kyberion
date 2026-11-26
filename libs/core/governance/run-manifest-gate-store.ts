/**
 * Run-manifest gate store access (pipeline-run-manifest-model.md §3.5): the
 * exact, synchronous governance I/O the external-operation gate of one
 * manifest-bound run performs while the run dispatches under the narrow
 * `surface_runtime` identity. The binding is opened by
 * run-manifest-gate-runtime.ts. Same shape as pr-publication-runtime.ts.
 */
import {
  assertStoreGrantIssuanceAllowed,
  isStoreGrantIssuanceRightRegistered,
} from '../authority.js';
import { currentExecutionScope, runInExecutionScope } from '../foundation/execution-scope.js';
import { resolvePolicyIdentityContext } from '../identity-context-bridge.js';
import {
  isRunManifestCharterScope,
  isOrganizationCharterScope,
  type CharterScope,
} from '../foundation/charter-scope.js';
import {
  currentRunManifestGateBinding,
  RUN_MANIFEST_GATE_GRANT_ISSUANCE_RIGHT,
  withRunManifestGateStoreGrant,
  type RunManifestGateStoreKind,
} from '../foundation/run-manifest-gate-store-capability.js';

/**
 * Is `scope` a charter scope the live gate binding covers (the bound tenant's
 * organization charters or the bound manifest's charters)?
 */
export function runManifestGateCoversCharterScope(scope: CharterScope): boolean {
  const gate = currentRunManifestGateBinding();
  if (!gate) return false;
  if (isRunManifestCharterScope(scope))
    return scope.tenant_slug === gate.tenantSlug && scope.manifest_hash === gate.manifestHash;
  return isOrganizationCharterScope(scope) && scope.tenant_slug === gate.tenantSlug;
}

/** The live gate binding's tenant, if any. */
export function currentRunManifestGateTenant(): string | undefined {
  return currentRunManifestGateBinding()?.tenantSlug;
}

/**
 * One synchronous, exact store access inside the live gate binding (the
 * charter registry, the external-operation reservation store and the review
 * artifact writer only; import boundary test). The opaque grant ends when
 * `action` returns and is itself the authority for the I/O it covers. The
 * caller keeps its own role (surface_runtime for a bound native run), bound to
 * the gate's tenant; a caller bound to another tenant is refused.
 */
export function withRunManifestGateStoreAccess<T>(
  kind: RunManifestGateStoreKind,
  read: string[],
  write: string[],
  action: () => T
): T {
  const authorizes = isStoreGrantIssuanceRightRegistered(RUN_MANIFEST_GATE_GRANT_ISSUANCE_RIGHT);
  return withRunManifestGateStoreGrant(kind, read, write, authorizes, () => {
    assertStoreGrantIssuanceAllowed(RUN_MANIFEST_GATE_GRANT_ISSUANCE_RIGHT);
    const tenant = currentRunManifestGateBinding()!.tenantSlug;
    const active = resolvePolicyIdentityContext().tenantSlug;
    if (active && active !== tenant)
      throw new Error(
        `[ROLE_TENANT_SCOPE_MISMATCH] run-manifest gate grant for tenant '${tenant}' used by a caller bound to '${active}'`
      );
    const {
      tenantCleared: _cleared,
      organizationId: _organization,
      tenantSlug: _tenant,
      ...current
    } = currentExecutionScope() ?? { tenantBound: false };
    return runInExecutionScope({ ...current, tenantBound: true, tenantSlug: tenant }, action);
  });
}
