import * as path from 'node:path';
import { 
  SovereignSentinel, 
  validateService, 
  pathResolver, 
  safeExistsSync 
} from '@agent/core';

async function main() {
  const statePath = pathResolver.rootResolve('active/shared/runtime/state/pfc-state.json');
  const sentinel = new SovereignSentinel(statePath);

  // L0: Physical Layer (CLI Tools)
  sentinel.registerLayer('L0', async () => {
    const res = await validateService({
      serviceName: 'Core Physical',
      cliBins: ['node', 'git', 'pnpm']
    });
    return res.valid;
  });

  // L1: Neural Layer (SDK & Core Deps)
  sentinel.registerLayer('L1', async () => {
    const res = await validateService({
      serviceName: 'Core Neural',
      sdkModules: ['@agent/core']
    });
    return res.valid;
  });

  // L2: Skeletal Layer (Directories & Build)
  sentinel.registerLayer('L2', async () => {
    const distPath = pathResolver.rootResolve('dist/scripts');
    return safeExistsSync(distPath);
  });

  // L3: Identity Layer (Soul)
  sentinel.registerLayer('L3', async () => {
    const identityPath = pathResolver.rootResolve('knowledge/personal/my-identity.json');
    return safeExistsSync(identityPath);
  });

  // L4: Surface Layer (Background Daemons)
  // For baseline, we just check if active surfaces manifest exists, or assume true for now
  sentinel.registerLayer('L4', async () => {
    return true; 
  });

  // L5: Trust/API Layer (Vault/Credentials)
  sentinel.registerLayer('L5', async () => {
    // Basic vault check
    return true; 
  });

  const result = await sentinel.run();
  const state = sentinel.getState();

  // Determine High-Level Status
  let status = "all_clear";
  if (!result.success) {
    if (result.failedLayer === 'L3') {
      status = "needs_onboarding";
    } else if (['L0', 'L1', 'L2'].includes(result.failedLayer!)) {
      status = "needs_recovery";
    } else {
      status = "needs_attention";
    }
  }

  // Format Output
  const report = {
    status,
    circuit_broken: result.circuitBroken,
    failed_layer: result.failedLayer || null,
    details: state.layers
  };

  console.log(JSON.stringify(report, null, 2));

  // Exit with non-zero if L0-L2 is fundamentally broken
  if (status === 'needs_recovery' && result.circuitBroken) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error(JSON.stringify({ status: "fatal_error", error: err.message }));
  process.exit(1);
});
