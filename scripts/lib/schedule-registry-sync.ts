/**
 * scripts/lib/schedule-registry-sync.ts — ADF `schedule` fields → schedule registry.
 *
 * Extracted from chronos_daemon.ts so the registry can be synced without the
 * daemon running (`pnpm kyberion scheduler reconcile`). Chronos still calls it
 * on start and before every tick. The tenant gates (registry-verified tenant
 * paths, tenant-bound reads, runtime allowlists) stay owned by chronos_daemon
 * and are passed in, so this module adds no second tenant policy.
 */
import * as path from 'node:path';
import { logger } from '@agent/core/core';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeLstat, safeReaddir } from '@agent/core/secure-io';
import { reconcileScheduledPipelines } from '@agent/core/pipeline-scheduler';

type ScheduledPipelineInput = Parameters<typeof reconcileScheduledPipelines>[1][number];

export type ScheduleScope = { kind: 'repository' } | { kind: 'tenant'; tenant_slug: string };

export interface ScheduleRegistrySyncDeps<S extends ScheduleScope = ScheduleScope> {
  rootDir?: string;
  /** Registered tenants' pipeline files (chronos collectTenantPipelineFiles). */
  collectTenantPipelineFiles: (rootDir: string) => Array<{ tenant_slug: string; file: string }>;
  /** Classify + load one file; adf null for non-pipeline JSON (chronos readScheduledPipelineAdf). */
  readScheduledPipelineAdf: (fullPath: string) => { scope: S; adf: any };
  /** Refuse tenant runtime needs beyond the allowlists (chronos resolveTenantRuntimeEnv). */
  assertTenantRuntime: (scope: Extract<S, { kind: 'tenant' }>, runtime: unknown) => void;
  /** Compute counts without writing the registry. */
  dryRun?: boolean;
}

export interface ScheduleRegistrySyncResult {
  added: number;
  updated: number;
  removed: number;
  unchanged: number;
  /** Schedules found in ADF files. */
  desired: number;
  skipped: Array<{ file: string; reason: string }>;
  dryRun: boolean;
}

/** Repository pipeline JSON files under `dir`, recursively, never following symlinks. */
export function collectPipelineFiles(dir: string): string[] {
  const found: string[] = [];
  if (!safeExistsSync(dir)) return found;
  for (const name of safeReaddir(dir)) {
    const full = path.join(dir, name);
    const stat = safeLstat(full);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) found.push(...collectPipelineFiles(full));
    else if (name.endsWith('.json')) found.push(full);
  }
  return found;
}

export function syncScheduleRegistry<S extends ScheduleScope>(
  deps: ScheduleRegistrySyncDeps<S>
): ScheduleRegistrySyncResult {
  const root = deps.rootDir ?? pathResolver.rootDir();
  const files = collectPipelineFiles(path.join(root, 'pipelines'));
  const tenantFiles = deps.collectTenantPipelineFiles(root);

  const desired: ScheduledPipelineInput[] = [];
  const skipped: ScheduleRegistrySyncResult['skipped'] = [];
  for (const fullPath of [...files, ...tenantFiles.map((entry) => entry.file)]) {
    // `_`-prefixed JSON files are test fixtures / partials — never schedulable.
    if (path.basename(fullPath).startsWith('_')) continue;
    try {
      const { scope, adf } = deps.readScheduledPipelineAdf(fullPath);
      if (!adf || !adf.schedule?.cron) continue;
      // Refuse to schedule a tenant pipeline whose runtime needs exceed its
      // tenant allowlist or the global ceiling (re-checked at run time too).
      if (scope.kind === 'tenant')
        deps.assertTenantRuntime(scope as Extract<S, { kind: 'tenant' }>, adf.runtime);

      const sched = adf.schedule;
      const baseId = sched.id ?? path.basename(fullPath, '.json');
      // Tenant schedules are namespaced so a tenant file can never shadow a
      // repository schedule id (or another tenant's).
      const id =
        scope.kind === 'tenant'
          ? `tenant-${(scope as Extract<ScheduleScope, { kind: 'tenant' }>).tenant_slug}-${baseId}`
          : baseId;

      desired.push({
        id,
        name: adf.name ?? id,
        pipelinePath: fullPath,
        actuator: 'run_pipeline',
        trigger: {
          type: 'cron',
          cron: sched.cron,
          timezone: sched.timezone,
        },
        enabled: sched.enabled !== false,
        managedBy: 'chronos_adf',
        // Shipped-disabled schedules run only when the host lists their id in
        // KYBERION_CHRONOS_SCHEDULES (see scheduleExplicitlyOptedIn).
        optIn: sched.enabled === false,
        // Tenant ADF context stays in the confidential file; the child reads it.
        context: scope.kind === 'tenant' ? {} : (adf.context ?? {}),
        deliver_to: sched.deliver_to,
      } as ScheduledPipelineInput);
    } catch (err: any) {
      const file = path.relative(root, fullPath);
      skipped.push({ file, reason: err?.message ?? String(err) });
      logger.warn(`[CHRONOS] Skipped ${file}: ${err?.message ?? String(err)}`);
    }
  }

  const result = reconcileScheduledPipelines('chronos_adf', desired, {
    dryRun: deps.dryRun === true,
  });
  const changed = result.added + result.updated + result.removed;
  if (changed > 0 && !deps.dryRun) {
    logger.info(
      `[CHRONOS] Reconciled schedules: ${result.added} added, ${result.updated} updated, ${result.removed} removed`
    );
  }
  return { ...result, desired: desired.length, skipped, dryRun: deps.dryRun === true };
}
