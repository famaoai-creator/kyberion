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
  killSwitch,
  readJanitorLastRunMs,
  readReasoningDegraded,
  validateEnv,
} from '@agent/core';
import { spawnManagedProcess } from '@agent/core/managed-process';
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
const JANITOR_MAINTENANCE_TTL_MS = 24 * 60 * 60 * 1000;
const JANITOR_SUBMIT_MARKER = 'runtime/state/janitor-last-submit.json';
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

export type BaselineMaintenanceState = {
  submitted: boolean;
  pending: boolean;
  reason: string | null;
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

function readJanitorLastSubmissionMs(): number | null {
  const markerPath = pathResolver.shared(JANITOR_SUBMIT_MARKER);
  if (!safeExistsSync(markerPath)) return null;
  try {
    const raw = safeReadFile(markerPath, { encoding: 'utf8' }) as string;
    const parsed = JSON.parse(raw) as { submitted_at?: string };
    const submittedAt = Date.parse(String(parsed?.submitted_at || ''));
    return Number.isFinite(submittedAt) ? submittedAt : null;
  } catch {
    return null;
  }
}

function markJanitorSubmission(): void {
  safeWriteFile(
    pathResolver.shared(JANITOR_SUBMIT_MARKER),
    JSON.stringify(
      {
        submitted_at: new Date().toISOString(),
        pipeline_id: 'storage-janitor',
        dry_run: false,
      },
      null,
      2
    )
  );
}

function maybeSubmitJanitorMaintenanceJob(): {
  submitted: boolean;
  pending: boolean;
  reason: string | null;
} {
  const lastCompletedMs = readJanitorLastRunMs();
  if (lastCompletedMs !== null && Date.now() - lastCompletedMs < JANITOR_MAINTENANCE_TTL_MS) {
    return { submitted: false, pending: false, reason: null };
  }

  const lastSubmittedMs = readJanitorLastSubmissionMs();
  if (lastSubmittedMs !== null && Date.now() - lastSubmittedMs < JANITOR_MAINTENANCE_TTL_MS) {
    return {
      submitted: false,
      pending: true,
      reason: 'storage janitor job is already pending',
    };
  }

  // Real run (not dry_run): the janitor only writes its completion marker on a
  // real run, so a dry-run submission can never satisfy readJanitorLastRunMs()
  // and would leave the baseline stuck at needs_attention for every TTL window.
  spawnManagedProcess({
    resourceId: `baseline-check:storage-janitor:${Date.now().toString(36)}`,
    kind: 'service',
    ownerId: 'baseline-check',
    ownerType: 'baseline-check-maintenance',
    command: process.execPath,
    args: [
      'dist/scripts/run_pipeline.js',
      '--input',
      'pipelines/storage-janitor.json',
      '--context',
      JSON.stringify({ dry_run: false }),
    ],
    spawnOptions: {
      cwd: pathResolver.rootDir(),
      env: process.env,
      detached: true,
      stdio: 'ignore',
    },
    shutdownPolicy: 'detached',
    metadata: {
      pipelineId: 'storage-janitor',
      dryRun: false,
      source: 'baseline-check',
    },
  });

  markJanitorSubmission();
  return {
    submitted: true,
    pending: true,
    reason: 'storage janitor job submitted',
  };
}

export function deriveBaselineStatus(
  result: { success: boolean; failedLayer?: string | null },
  janitorMaintenance: BaselineMaintenanceState,
  reasoningDegraded = false
): 'all_clear' | 'needs_onboarding' | 'needs_recovery' | 'needs_attention' {
  if (!result.success) {
    if (result.failedLayer === 'L3') return 'needs_onboarding';
    if (['L0', 'L1', 'L2'].includes(result.failedLayer || '')) return 'needs_recovery';
    return 'needs_attention';
  }
  if (janitorMaintenance.pending) return 'needs_attention';
  // LC-08: a healthy report while the reasoning chain silently degraded to
  // stub would invite real work on a fabricated brain — surface it.
  if (reasoningDegraded) return 'needs_attention';
  return 'all_clear';
}

async function main() {
  killSwitch.startMonitor();

  // KM-01 fallback: without a resident chronos daemon the scheduled janitor
  // never fires, so session start submits a detached dry-run maintenance job
  // when the last completed run is stale. Failure-tolerant — maintenance must
  // never block the baseline check.
  let janitorMaintenance = { submitted: false, pending: false, reason: null as string | null };
  try {
    janitorMaintenance = maybeSubmitJanitorMaintenanceJob();
    if (janitorMaintenance.submitted) {
      logger.info(
        `[BASELINE] storage janitor maintenance job submitted: ${janitorMaintenance.reason || 'storage janitor job submitted'}`
      );
    } else if (janitorMaintenance.pending) {
      logger.info(
        `[BASELINE] storage janitor maintenance pending: ${janitorMaintenance.reason || 'storage janitor job is already pending'}`
      );
    }
  } catch (err: any) {
    logger.warn(`[BASELINE] storage janitor fallback failed: ${err?.message ?? String(err)}`);
  }
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

  // L7: Configuration Layer (OP-05) — warn-only for unknown/malformed
  // KYBERION_* vars (surfaced via envReport below, never blocking); only a
  // missing `required: true` registry entry fails this layer.
  const envReport = validateEnv();
  sentinel.registerLayer('L7', async () => envReport.errors.length === 0);

  const result = await sentinel.run();
  const state = sentinel.getState();

  // LC-08: bootstrap writes this marker when a non-stub mode kept stubs.
  const reasoningDegraded = readReasoningDegraded();

  // Determine High-Level Status
  const status = deriveBaselineStatus(result, janitorMaintenance, reasoningDegraded !== null);

  // Format Output
  const report = {
    status,
    circuit_broken: result.circuitBroken,
    failed_layer: result.failedLayer || null,
    details: state.layers,
    config_degraded: baselineConfigDegraded,
    reasoning_degraded: reasoningDegraded,
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
    maintenance: {
      janitor: {
        required: janitorMaintenance.pending || janitorMaintenance.submitted,
        submitted: janitorMaintenance.submitted,
        pending: janitorMaintenance.pending,
        reason: janitorMaintenance.reason,
      },
    },
    env: {
      checked: envReport.checked,
      errors: envReport.errors,
      warnings: envReport.warnings,
      unknown: envReport.unknown,
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
