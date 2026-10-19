/** CLI compatibility wrapper for the canonical tenant registry consistency service. */
import { runCheck } from '@agent/core/organization/tenant-registry-consistency';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

export * from '@agent/core/organization/tenant-registry-consistency';

export const runCheckTenantRegistry = defineScript({
  name: 'check:tenant-registry',
  flags: [],
  run(context) {
    const { exitCode, output } = runCheck();
    if (exitCode === 0) context.print(output);
    else throw new ScriptExitError(exitCode, output);
    return { exitCode, output };
  },
});

if (
  isDirectScript(import.meta.url, 'check_tenant_registry_consistency.ts') ||
  isDirectScript(import.meta.url, 'check_tenant_registry_consistency.js')
)
  void runCheckTenantRegistry();
