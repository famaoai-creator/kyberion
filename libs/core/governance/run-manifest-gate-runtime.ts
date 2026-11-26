/**
 * Run-manifest gate store binding (pipeline-run-manifest-model.md §3.5). It
 * confers no execution or decision authority: it only lets the
 * external-operation gate of one manifest-bound run read and record that run's
 * own tenant governance state (run-manifest-gate-store.ts) while the run
 * dispatches under the narrow `surface_runtime` identity. Same shape as
 * pr-publication-runtime.ts.
 */
import { resolvePolicyIdentityContext } from '../identity-context-bridge.js';
import { withRunManifestGateBinding } from '../foundation/run-manifest-gate-store-capability.js';
import { currentRunManifestBinding } from './run-manifest-binding.js';

/**
 * Bind the gate store of one admitting run (run-manifest-session.ts only:
 * `RunManifestSession.withGateStore`; import boundary test). It must run inside
 * that run's own run-manifest binding (same run id and manifest), and
 * `tenantSlug` — the run's location-derived tenant — must be the manifest's
 * tenant; a caller bound to another tenant is refused. The binding confers no
 * I/O by itself.
 */
export function withRunManifestGateStore<T>(
  run: { tenantSlug: string; runId: string; manifestHash: string },
  action: () => T
): T {
  const binding = currentRunManifestBinding();
  if (
    !binding ||
    binding.runId !== run.runId ||
    binding.manifest.manifest_hash !== run.manifestHash
  )
    throw new Error(
      "[RUN_MANIFEST_GATE_SCOPE] the run's own run-manifest binding must be installed first"
    );
  if (binding.manifest.scope.tenant_slug !== run.tenantSlug)
    throw new Error(
      `[RUN_MANIFEST_GATE_SCOPE] run tenant '${run.tenantSlug}' is not the bound manifest's tenant`
    );
  const active = resolvePolicyIdentityContext().tenantSlug;
  if (active && active !== run.tenantSlug)
    throw new Error(
      `[ROLE_TENANT_SCOPE_MISMATCH] run-manifest gate store for tenant '${run.tenantSlug}' opened by a caller bound to '${active}'`
    );
  return withRunManifestGateBinding(run.tenantSlug, run.manifestHash, action);
}
