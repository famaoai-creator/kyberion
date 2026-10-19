/** CLI adapter: retain the full operator registry audit outside scoped Web services. */
import {
  createTenantActivationProbeDeps,
  runTenantActivationProbes as runScopedTenantActivationProbes,
  type TenantActivationProbeInput,
  type TenantActivationProbeDeps,
} from '@agent/core/organization/tenant-activation-probe';
import { runCheck } from '@agent/core/organization/tenant-registry-consistency';

export type {
  ProbeResult,
  TenantActivationProbeInput,
  TenantActivationProbeDeps,
} from '@agent/core/organization/tenant-activation-probe';

export function runTenantActivationProbes(
  input: TenantActivationProbeInput,
  deps: TenantActivationProbeDeps = {
    ...createTenantActivationProbeDeps(input),
    registryCheck: () => ({ ...runCheck(), scope: 'global' }),
  }
) {
  return runScopedTenantActivationProbes(input, deps);
}
