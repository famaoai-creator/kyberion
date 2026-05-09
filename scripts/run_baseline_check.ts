import * as path from 'node:path';
import { 
  SovereignSentinel, 
  validateService, 
  customerResolver,
  pathResolver, 
  safeExistsSync,
  safeReadFile,
  withExecutionContext,
} from '@agent/core';
import { scanTenantDrift } from './watch_tenant_drift.js';

function hasAnyKey(obj: Record<string, unknown>, keys: string[]): boolean {
  return keys.some((key) => {
    const value = obj[key];
    return typeof value === 'string' ? value.trim().length > 0 : value !== undefined && value !== null;
  });
}

type ReadinessRule = {
  required_keys_any?: string[];
};

function loadConnectionReadinessConfig(): {
  requiredServices: Record<string, ReadinessRule>;
  tenantGuard: { requireZeroDrift: boolean };
} {
  const configPath = pathResolver.rootResolve('knowledge/public/governance/service-connection-readiness.json');
  if (!safeExistsSync(configPath)) {
    return {
      requiredServices: {},
      tenantGuard: { requireZeroDrift: true },
    };
  }
  try {
    const parsed = JSON.parse(safeReadFile(configPath, { encoding: 'utf8' }) as string);
    return {
      requiredServices:
        parsed?.required_services && typeof parsed.required_services === 'object'
          ? parsed.required_services
          : {},
      tenantGuard: {
        requireZeroDrift: parsed?.tenant_guard?.require_zero_drift !== false,
      },
    };
  } catch (_) {
    return {
      requiredServices: {},
      tenantGuard: { requireZeroDrift: true },
    };
  }
}

function profileRoot(): string {
  return customerResolver.customerRoot('') ?? pathResolver.knowledge('personal');
}

function checkServiceConnectionReadiness(): boolean {
  return withExecutionContext('mission_controller', () => {
    const endpointsPath = pathResolver.rootResolve('knowledge/public/orchestration/service-endpoints.json');
    if (!safeExistsSync(endpointsPath)) return false;
    const endpoints = JSON.parse(safeReadFile(endpointsPath, { encoding: 'utf8' }) as string);
    const services = endpoints?.services || {};

    const readinessConfig = loadConnectionReadinessConfig();
    const readinessRules = readinessConfig.requiredServices;
    if (Object.keys(readinessRules).length === 0) return false;

    for (const [serviceId, rule] of Object.entries(readinessRules)) {
      const service = services[serviceId];
      if (!service?.preset_path) return false;
      const presetPath = pathResolver.rootResolve(String(service.preset_path));
      if (!safeExistsSync(presetPath)) return false;

      const connectionPath = path.join(profileRoot(), 'connections', `${serviceId}.json`);
      if (!safeExistsSync(connectionPath)) return false;
      const connection = JSON.parse(safeReadFile(connectionPath, { encoding: 'utf8' }) as string) as Record<string, unknown>;
      const requiredAny = Array.isArray(rule?.required_keys_any) ? rule.required_keys_any : [];
      if (requiredAny.length > 0 && !hasAnyKey(connection, requiredAny)) return false;
    }

    if (readinessConfig.tenantGuard.requireZeroDrift) {
      const drift = scanTenantDrift();
      if (drift.findings.length > 0) return false;
    }

    return true;
  });
}

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
    const identityPath = path.join(profileRoot(), 'my-identity.json');
    return safeExistsSync(identityPath);
  });

  // L4: Surface Layer (Background Daemons)
  sentinel.registerLayer('L4', async () => {
    const surfacesPath = pathResolver.rootResolve('knowledge/public/governance/active-surfaces.json');
    return safeExistsSync(surfacesPath);
  });

  // L5: Trust/API Layer (Vault/Credentials)
  sentinel.registerLayer('L5', async () => {
    return checkServiceConnectionReadiness();
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
