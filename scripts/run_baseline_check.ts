import * as path from 'node:path';
import {
  SovereignSentinel,
  validateService,
  pathResolver,
  resolveActiveProfileRoot,
  safeExistsSync,
  safeReadFile,
  safeWriteFile,
  logger,
  withExecutionContext,
  loadServiceEndpointsCatalog,
} from '@agent/core';
import { runCoworkHealthCheck } from '@agent/core/cowork-health-check';
import { scanTenantDrift } from './watch_tenant_drift.js';

function hasAnyKey(obj: Record<string, unknown>, keys: string[]): boolean {
  return keys.some((key) => {
    const value = obj[key];
    return typeof value === 'string'
      ? value.trim().length > 0
      : value !== undefined && value !== null;
  });
}

type ReadinessRule = {
  required_keys_any?: string[];
};

const BASELINE_CACHE_TTL_MS = 60 * 60 * 1000;
const BASELINE_CACHE_DIR = 'runtime/baseline-check-cache';
let baselineConfigDegraded = false;

type CachedEnvelope<T> = {
  computed_at: string;
  ttl_ms: number;
  value: T;
};

type CachedSnapshot<T> = {
  value: T;
  cached: boolean;
  age_ms?: number;
};

function cachePath(name: string): string {
  return pathResolver.shared(`${BASELINE_CACHE_DIR}/${name}.json`);
}

function loadCachedSnapshot<T>(name: string): CachedSnapshot<T> | null {
  const path = cachePath(name);
  if (!safeExistsSync(path)) return null;
  try {
    const raw = safeReadFile(path, { encoding: 'utf8' }) as string;
    const parsed = JSON.parse(raw) as CachedEnvelope<T>;
    const computedAt = new Date(parsed.computed_at).getTime();
    if (!Number.isFinite(computedAt)) return null;
    const ageMs = Date.now() - computedAt;
    if (ageMs > parsed.ttl_ms) return null;
    return {
      value: parsed.value,
      cached: true,
      age_ms: ageMs,
    };
  } catch {
    return null;
  }
}

function storeCachedSnapshot<T>(name: string, value: T, ttlMs: number): void {
  safeWriteFile(
    cachePath(name),
    JSON.stringify(
      {
        computed_at: new Date().toISOString(),
        ttl_ms: ttlMs,
        value,
      } satisfies CachedEnvelope<T>,
      null,
      2
    )
  );
}

function loadConnectionReadinessConfig(): {
  requiredServices: Record<string, ReadinessRule>;
  tenantGuard: { requireZeroDrift: boolean };
  configDegraded: boolean;
} {
  const configPath = pathResolver.rootResolve(
    'knowledge/product/governance/service-connection-readiness.json'
  );
  if (!safeExistsSync(configPath)) {
    baselineConfigDegraded = false;
    return {
      requiredServices: {},
      tenantGuard: { requireZeroDrift: true },
      configDegraded: false,
    };
  }
  try {
    const raw = safeReadFile(configPath, { encoding: 'utf8' }) as string;
    return parseConnectionReadinessConfig(raw, configPath);
  } catch (_) {
    baselineConfigDegraded = true;
    logger.warn(
      `[baseline-check] service-connection-readiness config parse failed, falling back to defaults: ${configPath}`
    );
    return {
      requiredServices: {},
      tenantGuard: { requireZeroDrift: true },
      configDegraded: true,
    };
  }
}

export function parseConnectionReadinessConfig(
  raw: string,
  configPath = 'service-connection-readiness.json'
): {
  requiredServices: Record<string, ReadinessRule>;
  tenantGuard: { requireZeroDrift: boolean };
  configDegraded: boolean;
} {
  try {
    const parsed = JSON.parse(raw);
    baselineConfigDegraded = false;
    return {
      requiredServices:
        parsed?.required_services && typeof parsed.required_services === 'object'
          ? parsed.required_services
          : {},
      tenantGuard: {
        requireZeroDrift: parsed?.tenant_guard?.require_zero_drift !== false,
      },
      configDegraded: false,
    };
  } catch (_) {
    baselineConfigDegraded = true;
    logger.warn(
      `[baseline-check] service-connection-readiness config parse failed, falling back to defaults: ${configPath}`
    );
    return {
      requiredServices: {},
      tenantGuard: { requireZeroDrift: true },
      configDegraded: true,
    };
  }
}

function profileRoot(): string {
  return resolveActiveProfileRoot();
}

function checkServiceConnectionReadiness(
  tenantDriftReport?: ReturnType<typeof scanTenantDrift>
): boolean {
  return withExecutionContext('mission_controller', () => {
    const endpoints = loadServiceEndpointsCatalog();
    const services = endpoints?.services || {};

    const readinessConfig = loadConnectionReadinessConfig();
    if (readinessConfig.configDegraded) return false;
    const readinessRules = readinessConfig.requiredServices;
    if (Object.keys(readinessRules).length === 0) return false;

    for (const [serviceId, rule] of Object.entries(readinessRules)) {
      const service = services[serviceId];
      if (!service?.preset_path) return false;
      const presetPath = pathResolver.rootResolve(String(service.preset_path));
      if (!safeExistsSync(presetPath)) return false;

      const connectionPath = path.join(profileRoot(), 'connections', `${serviceId}.json`);
      if (!safeExistsSync(connectionPath)) return false;
      const connection = JSON.parse(
        safeReadFile(connectionPath, { encoding: 'utf8' }) as string
      ) as Record<string, unknown>;
      const requiredAny = Array.isArray(rule?.required_keys_any) ? rule.required_keys_any : [];
      if (requiredAny.length > 0 && !hasAnyKey(connection, requiredAny)) return false;
    }

    if (readinessConfig.tenantGuard.requireZeroDrift) {
      const drift = tenantDriftReport ?? scanTenantDrift();
      if (drift.findings.length > 0) return false;
    }

    return true;
  });
}

function getCachedTenantDrift() {
  const cached = loadCachedSnapshot<ReturnType<typeof scanTenantDrift>>('tenant-drift');
  if (cached) return cached;
  const value = scanTenantDrift();
  storeCachedSnapshot('tenant-drift', value, BASELINE_CACHE_TTL_MS);
  return { value, cached: false } satisfies CachedSnapshot<ReturnType<typeof scanTenantDrift>>;
}

function getCachedCoworkHealth() {
  const cached = loadCachedSnapshot<ReturnType<typeof runCoworkHealthCheck>>('cowork-health');
  if (cached) return cached;
  const value = runCoworkHealthCheck();
  storeCachedSnapshot('cowork-health', value, BASELINE_CACHE_TTL_MS);
  return { value, cached: false } satisfies CachedSnapshot<ReturnType<typeof runCoworkHealthCheck>>;
}

async function main() {
  const statePath = pathResolver.rootResolve('active/shared/runtime/state/pfc-state.json');
  const sentinel = new SovereignSentinel(statePath);
  const tenantDriftSnapshot = getCachedTenantDrift();
  const coworkHealthSnapshot = getCachedCoworkHealth();

  // L0: Physical Layer (CLI Tools)
  sentinel.registerLayer('L0', async () => {
    const res = await validateService({
      serviceName: 'Core Physical',
      cliBins: ['node', 'git', 'pnpm'],
    });
    return res.valid;
  });

  // L1: Neural Layer (SDK & Core Deps)
  sentinel.registerLayer('L1', async () => {
    const res = await validateService({
      serviceName: 'Core Neural',
      sdkModules: ['@agent/core'],
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
    const surfacesDir = pathResolver.rootResolve('knowledge/product/governance/surfaces');
    const surfacesSnapshot = pathResolver.rootResolve(
      'knowledge/product/governance/active-surfaces.json'
    );
    return safeExistsSync(surfacesDir) && safeExistsSync(surfacesSnapshot);
  });

  // L5: Trust/API Layer (Vault/Credentials)
  sentinel.registerLayer('L5', async () => {
    return checkServiceConnectionReadiness(tenantDriftSnapshot.value);
  });

  // L6: Cowork Integration Layer
  sentinel.registerLayer('L6', async () => {
    const coworkHealth = coworkHealthSnapshot.value;
    if (coworkHealth.warnings.length > 0) {
      coworkHealth.warnings.forEach((w) => process.stderr.write(`[COWORK WARN] ${w}\n`));
    }
    return coworkHealth.healthy;
  });

  const result = await sentinel.run();
  const state = sentinel.getState();

  // Determine High-Level Status
  let status = 'all_clear';
  if (!result.success) {
    if (result.failedLayer === 'L3') {
      status = 'needs_onboarding';
    } else if (['L0', 'L1', 'L2'].includes(result.failedLayer!)) {
      status = 'needs_recovery';
    } else {
      status = 'needs_attention';
    }
  }

  // Format Output
  const report = {
    status,
    circuit_broken: result.circuitBroken,
    failed_layer: result.failedLayer || null,
    details: state.layers,
    config_degraded: baselineConfigDegraded,
    cache: {
      tenant_drift: {
        cached: tenantDriftSnapshot.cached,
        age_ms: tenantDriftSnapshot.age_ms ?? null,
      },
      cowork_health: {
        cached: coworkHealthSnapshot.cached,
        age_ms: coworkHealthSnapshot.age_ms ?? null,
      },
    },
  };

  console.log(JSON.stringify(report, null, 2));

  // Exit with non-zero if L0-L2 is fundamentally broken
  if (status === 'needs_recovery' && result.circuitBroken) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ status: 'fatal_error', error: err.message }));
  process.exit(1);
});
