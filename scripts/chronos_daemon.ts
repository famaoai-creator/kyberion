/**
 * scripts/chronos_daemon.ts
 * Kyberion Pipeline Scheduler Daemon
 *
 * Scans pipelines/ for ADF files that declare a `schedule` field and
 * auto-registers them with the pipeline-scheduler registry. Runs a tick
 * every 60 s, executes any pipelines due now, and records lastRun/lastStatus.
 *
 * Tenant-scoped schedules: for every REGISTERED, operational tenant, the
 * direct children of knowledge/confidential/{tenant}/pipelines/*.json are
 * scanned too (the README convention for tenant instantiations). They are
 * deny-by-default: no symlinks anywhere on the path, the tenant is re-derived
 * from the path (never from stored context) and re-verified against the
 * registry at run time, and the run happens in a CHILD process bound to that
 * tenant (KYBERION_TENANT + KYBERION_TENANT_SCOPE_REQUIRED=1, role
 * chronos_tenant_runner) — the role and tenant binding never touch this
 * process, so concurrently running schedules cannot observe them.
 */

import * as path from 'node:path';
import { logger } from '@agent/core/core';
import { pathResolver } from '@agent/core/path-resolver';
import { recordDaemonHeartbeat } from '@agent/core/daemon-heartbeat';
import { safeExistsSync, safeLstat, safeReaddir } from '@agent/core/secure-io';
import { sendOpsAlert } from '@agent/core/ops-alert';
import {
  registerScheduledPipeline,
  resolveScheduledPipelinePath,
  getSchedulesDueNow,
  claimScheduledPipelineRun,
  completeScheduledPipelineRun,
} from '@agent/core/pipeline-scheduler';
import {
  enqueueChronosDelivery,
  validateChronosDeliveryTarget,
} from '@agent/core/chronos-delivery';
import { createTriggerRunner, withTriggerLeaderLease } from '@agent/core/trigger-runner';
import { withExecutionContext, withExecutionContextAsync } from '@agent/core/authority';
import { listTenantProfileSlugs, resolveTenant } from '@agent/core/tenant-registry';
import { isValidTenantSlug } from '@agent/core/entity-scope';
import { assertSafeRepositoryPath, safeExecResultAsync, safeReadFile } from '@agent/core/secure-io';
import { loadServiceEndpointsCatalog } from '@agent/core/service-endpoint-registry';
import { loadReasoningBackendPolicy } from '@agent/core/reasoning-backend-policy';
import { findValidProjectTrustApproval } from '@agent/core/project-trust';
import type { ChronosDeliveryTarget } from '@agent/core/chronos-delivery';
import { readValidatedPipelineAdf } from './refactor/adf-input.js';
import { runSteps } from './run_pipeline.js';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

const TICK_INTERVAL_MS = 60_000;
const triggerRunner = createTriggerRunner();

// ---------------------------------------------------------------------------
// ADF scan → registry sync
// ---------------------------------------------------------------------------

function collectPipelineFiles(dir: string): string[] {
  const found: string[] = [];
  if (!safeExistsSync(dir)) return found;
  const entries = safeReaddir(dir);
  for (const name of entries) {
    const full = path.join(dir, name);
    const stat = safeLstat(full);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      found.push(...collectPipelineFiles(full));
    } else if (name.endsWith('.json')) {
      found.push(full);
    }
  }
  return found;
}

/** Authority role of the tenant-bound child process (security-policy.json). */
export const CHRONOS_TENANT_RUNNER_ROLE = 'chronos_tenant_runner';

/** Wall-clock budget for one tenant pipeline child run. */
const TENANT_RUN_TIMEOUT_MS = 30 * 60_000;

/**
 * Tenant-side ceiling for what a tenant pipeline's `runtime` block may
 * request, relative to the tenant knowledge root. Absent file = nothing may
 * be requested (deny-by-default).
 */
export const TENANT_RUNTIME_ALLOWLIST_RELATIVE = 'governance/pipeline-runtime-allowlist.json';

/** What a tenant pipeline declares it needs at run time (ADF `runtime`). */
export interface TenantPipelineRuntime {
  authorized_scope?: string[];
  reasoning_backend?: string;
  egress_policy_ref?: string;
}

interface TenantRuntimeAllowlist {
  authorized_scopes?: string[];
  reasoning_backends?: string[];
  egress_policy_refs?: string[];
}

export type ChronosPipelineScope =
  | { kind: 'repository'; relative: string }
  | { kind: 'tenant'; relative: string; tenant_slug: string };

const TENANT_PIPELINE_RE = /^knowledge\/confidential\/([^/]+)\/pipelines\/[^/]+\.json$/;

function assertNoSymlinkSegments(root: string, relative: string): void {
  let current = root;
  for (const segment of relative.split('/')) {
    current = path.join(current, segment);
    try {
      if (safeLstat(current).isSymbolicLink()) {
        throw new Error(
          `[CHRONOS_SCOPE] scheduled pipeline cannot traverse a symbolic link: ${relative}`
        );
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('[CHRONOS_SCOPE]')) throw error;
      throw new Error(
        `[CHRONOS_SCOPE] scheduled pipeline could not be inspected safely: ${relative}`
      );
    }
  }
}

/**
 * Symlink-free check for tenant paths. Uses the policy-free repository path
 * guard: lstat-walking knowledge/confidential/ itself would be a tier-guarded
 * read outside any single tenant's scope.
 */
function assertNoSymlinkTenantPath(root: string, relative: string): void {
  try {
    assertSafeRepositoryPath(path.join(root, relative), { rootDir: root, allowMissingLeaf: true });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      reason.includes('[RESOURCE_PATH_SYMLINK]')
        ? `[CHRONOS_SCOPE] scheduled pipeline cannot traverse a symbolic link: ${relative}`
        : `[CHRONOS_SCOPE] scheduled pipeline could not be inspected safely: ${relative}`
    );
  }
}

/**
 * Chronos executes repository-owned pipelines (pipelines/**) and tenant-scoped
 * pipelines (knowledge/confidential/{tenant}/pipelines/*.json, direct children
 * only). Anything else — including symlinked segments — is refused. The
 * returned scope is derived from the PATH alone; callers must still verify a
 * tenant scope against the tenant registry (assertRegisteredTenantPipeline).
 */
export function assertChronosPipelinePath(
  inputPath: string,
  rootDir = pathResolver.rootDir()
): ChronosPipelineScope {
  const root = path.resolve(rootDir);
  const absolute = path.resolve(inputPath);
  const relative = path.relative(root, absolute).replaceAll('\\', '/');
  const outside = !relative || relative.startsWith('../') || path.isAbsolute(relative);
  const repository = !outside && relative.startsWith('pipelines/') && relative.endsWith('.json');
  const tenantMatch = outside ? null : TENANT_PIPELINE_RE.exec(relative);
  const tenantSlug = tenantMatch?.[1];
  if (!repository && !(tenantSlug && isValidTenantSlug(tenantSlug))) {
    throw new Error(
      `[CHRONOS_SCOPE] scheduled pipeline must be a repository pipeline JSON or a tenant pipeline under knowledge/confidential/{tenant}/pipelines/: ${relative || inputPath}`
    );
  }
  if (repository) assertNoSymlinkSegments(root, relative);
  else assertNoSymlinkTenantPath(root, relative);
  return repository
    ? { kind: 'repository', relative }
    : { kind: 'tenant', relative, tenant_slug: tenantSlug as string };
}

/**
 * Deny-by-default registry check for a tenant pipeline: the tenant must have
 * an operational profile and its knowledge root must be the path's root.
 * Runs under the tenant-bound runner role (sync — never across an await).
 */
export function assertRegisteredTenantPipeline(
  scope: Extract<ChronosPipelineScope, { kind: 'tenant' }>,
  rootDir = pathResolver.rootDir()
): void {
  const knowledgeRoot = withExecutionContext(
    CHRONOS_TENANT_RUNNER_ROLE,
    () => resolveTenant(scope.tenant_slug, { rootDir }).knowledge_root,
    undefined,
    scope.tenant_slug
  );
  if (!scope.relative.startsWith(`${knowledgeRoot}/pipelines/`)) {
    throw new Error(
      `[CHRONOS_SCOPE] tenant pipeline ${scope.relative} is outside ${scope.tenant_slug}'s registered knowledge root`
    );
  }
}

/**
 * Tenant pipeline files: direct *.json children of each registered,
 * operational tenant's `{knowledge_root}/pipelines/`. Each tenant's directory
 * is listed under that tenant's own binding — no cross-tenant read.
 */
export function collectTenantPipelineFiles(
  rootDir = pathResolver.rootDir()
): Array<{ tenant_slug: string; file: string }> {
  const slugs = withExecutionContext(CHRONOS_TENANT_RUNNER_ROLE, () =>
    listTenantProfileSlugs({ rootDir })
  );
  const found: Array<{ tenant_slug: string; file: string }> = [];
  for (const slug of slugs) {
    try {
      withExecutionContext(
        CHRONOS_TENANT_RUNNER_ROLE,
        () => {
          const knowledgeRoot = resolveTenant(slug, { rootDir }).knowledge_root;
          if (knowledgeRoot !== `knowledge/confidential/${slug}`) return;
          const relativeDir = `${knowledgeRoot}/pipelines`;
          const dir = path.join(rootDir, relativeDir);
          if (!safeExistsSync(dir)) return;
          assertNoSymlinkTenantPath(path.resolve(rootDir), relativeDir);
          for (const name of safeReaddir(dir).sort()) {
            if (!name.endsWith('.json')) continue;
            const full = path.join(dir, name);
            const stat = safeLstat(full);
            if (stat.isSymbolicLink() || !stat.isFile()) continue;
            found.push({ tenant_slug: slug, file: full });
          }
        },
        undefined,
        slug
      );
    } catch (err: any) {
      // Suspended/archived/invalid tenants are simply not scheduled.
      logger.info(`[CHRONOS] tenant ${slug} pipelines not scanned: ${err?.message ?? err}`);
    }
  }
  return found;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((entry) => String(entry)) : [];
}

function refuseRuntime(scope: { relative: string }, message: string): never {
  throw new Error(`[CHRONOS_RUNTIME] ${scope.relative}: ${message}`);
}

/**
 * Resolve a tenant pipeline's declared `runtime` needs into the child-process
 * env, deny-by-default: every value must be (1) declared in the ADF — which
 * the project-trust approval hashes, so a human approved exactly these —
 * (2) inside the tenant's own allowlist ({knowledge_root}/governance/
 * pipeline-runtime-allowlist.json), and (3) inside the global ceiling
 * (known service ids, governed reasoning modes, the tenant's own root for
 * the egress overlay). Nothing is taken from the daemon's environment.
 */
export function resolveTenantRuntimeEnv(
  scope: Extract<ChronosPipelineScope, { kind: 'tenant' }>,
  runtime: unknown,
  rootDir = pathResolver.rootDir()
): Record<string, string> {
  if (runtime === undefined || runtime === null) return {};
  if (typeof runtime !== 'object' || Array.isArray(runtime)) {
    refuseRuntime(scope, 'runtime must be an object');
  }
  const declared = runtime as TenantPipelineRuntime;
  const wantsAnything =
    stringList(declared.authorized_scope).length > 0 ||
    Boolean(declared.reasoning_backend) ||
    Boolean(declared.egress_policy_ref);
  if (!wantsAnything) return {};

  const allowlist = withExecutionContext(
    CHRONOS_TENANT_RUNNER_ROLE,
    (): TenantRuntimeAllowlist | null => {
      const knowledgeRoot = resolveTenant(scope.tenant_slug, { rootDir }).knowledge_root;
      const relative = `${knowledgeRoot}/${TENANT_RUNTIME_ALLOWLIST_RELATIVE}`;
      assertNoSymlinkTenantPath(path.resolve(rootDir), relative);
      const file = path.join(rootDir, relative);
      if (!safeExistsSync(file)) return null;
      return JSON.parse(String(safeReadFile(file, { encoding: 'utf8' }))) as TenantRuntimeAllowlist;
    },
    undefined,
    scope.tenant_slug
  );
  if (!allowlist) {
    refuseRuntime(
      scope,
      `runtime needs are declared but tenant '${scope.tenant_slug}' has no ${TENANT_RUNTIME_ALLOWLIST_RELATIVE} (deny-by-default)`
    );
  }
  const env: Record<string, string> = {};

  const scopes = stringList(declared.authorized_scope);
  if (scopes.length > 1) {
    refuseRuntime(
      scope,
      'authorized_scope carries one service per process (secret-guard AUTHORIZED_SCOPE)'
    );
  }
  if (scopes.length === 1) {
    const service = scopes[0];
    const knownServices = Object.keys(loadServiceEndpointsCatalog().services ?? {});
    if (!knownServices.includes(service)) {
      refuseRuntime(
        scope,
        `authorized_scope '${service}' is not a registered service (global ceiling)`
      );
    }
    if (!stringList(allowlist.authorized_scopes).includes(service)) {
      refuseRuntime(
        scope,
        `authorized_scope '${service}' is not in tenant '${scope.tenant_slug}' allowlist ${TENANT_RUNTIME_ALLOWLIST_RELATIVE}`
      );
    }
    env.AUTHORIZED_SCOPE = service;
  }

  if (declared.reasoning_backend) {
    const backend = String(declared.reasoning_backend);
    const policy = loadReasoningBackendPolicy();
    if (!policy.allowed_modes.includes(backend as never) || backend === 'stub') {
      refuseRuntime(
        scope,
        `reasoning_backend '${backend}' is not a governed reasoning mode (global ceiling)`
      );
    }
    if (!stringList(allowlist.reasoning_backends).includes(backend)) {
      refuseRuntime(
        scope,
        `reasoning_backend '${backend}' is not in tenant '${scope.tenant_slug}' allowlist ${TENANT_RUNTIME_ALLOWLIST_RELATIVE}`
      );
    }
    env.KYBERION_REASONING_BACKEND = backend;
  }

  if (declared.egress_policy_ref) {
    const ref = String(declared.egress_policy_ref).replace(/\\/g, '/');
    const tenantRoot = `knowledge/confidential/${scope.tenant_slug}/`;
    if (!ref.startsWith(tenantRoot) || ref.split('/').includes('..') || !ref.endsWith('.json')) {
      refuseRuntime(scope, `egress_policy_ref must be a JSON file inside ${tenantRoot}`);
    }
    if (!stringList(allowlist.egress_policy_refs).includes(ref)) {
      refuseRuntime(
        scope,
        `egress_policy_ref '${ref}' is not in tenant '${scope.tenant_slug}' allowlist ${TENANT_RUNTIME_ALLOWLIST_RELATIVE}`
      );
    }
    assertNoSymlinkTenantPath(path.resolve(rootDir), ref);
    env.KYBERION_TENANT_EGRESS_POLICY_PATH = ref;
  }
  return env;
}

/**
 * Child-process environment for one tenant-bound run: the tenant binding plus
 * ONLY the resolved runtime needs of that pipeline. Nothing is forwarded from
 * the daemon (no daemon-wide AUTHORIZED_SCOPE, backend or egress override).
 */
export function buildTenantRunEnv(
  tenantSlug: string,
  runtimeEnv: Record<string, string> = {}
): Record<string, string> {
  return {
    // Explicit blanks so values from the daemon's own env (secure-io's base
    // allowlist forwards some identity keys) can never reach a tenant run.
    AUTHORIZED_SCOPE: '',
    KYBERION_TENANT_EGRESS_POLICY_PATH: '',
    ...runtimeEnv,
    KYBERION_TENANT: tenantSlug,
    KYBERION_TENANT_SCOPE_REQUIRED: '1',
    MISSION_ROLE: CHRONOS_TENANT_RUNNER_ROLE,
    KYBERION_PERSONA: 'worker',
    // A daemon-level sudo must never leak into a tenant run.
    KYBERION_SUDO: '',
  };
}

/**
 * The human gate for unattended tenant runs: an approved, authenticated
 * project-trust decision bound to the CURRENT content of this exact file
 * (any edit invalidates it). Without one the run is refused.
 */
export function requireTenantPipelineTrust(
  scope: Extract<ChronosPipelineScope, { kind: 'tenant' }>
): string {
  const approvalId = withExecutionContext(
    CHRONOS_TENANT_RUNNER_ROLE,
    () => findValidProjectTrustApproval(scope.relative),
    undefined,
    scope.tenant_slug
  );
  if (!approvalId) {
    throw new Error(
      `[TRUST_REQUIRED] tenant pipeline ${scope.relative} has no approved project-trust decision for its current content — ` +
        `run \`pnpm kyberion project-trust request ${scope.relative}\` and have a human approve it`
    );
  }
  return approvalId;
}

async function runTenantPipelineInChild(
  scope: Extract<ChronosPipelineScope, { kind: 'tenant' }>,
  projectTrustApprovalId: string,
  runtimeEnv: Record<string, string>
): Promise<'succeeded' | 'failed'> {
  const root = pathResolver.rootDir();
  const result = await safeExecResultAsync(
    process.execPath,
    [
      path.join(root, 'dist/scripts/run_pipeline.js'),
      '--input',
      scope.relative,
      '--project-trust-approval',
      projectTrustApprovalId,
    ],
    {
      cwd: root,
      env: buildTenantRunEnv(scope.tenant_slug, runtimeEnv),
      timeoutMs: TENANT_RUN_TIMEOUT_MS,
    }
  );
  if (result.status !== 0) {
    const tail = `${result.stderr || ''}${result.stdout || ''}`
      .trim()
      .split('\n')
      .slice(-5)
      .join(' | ');
    logger.error(
      `[CHRONOS] tenant run ${scope.relative} exited ${String(result.status)}: ${tail.slice(0, 600)}`
    );
    return 'failed';
  }
  return 'succeeded';
}

/**
 * Classify and load one schedulable pipeline file. Tenant files are verified
 * against the registry and read under that tenant's binding only.
 */
export function readScheduledPipelineAdf(fullPath: string): {
  scope: ChronosPipelineScope;
  adf: any;
} {
  const scope = assertChronosPipelinePath(fullPath);
  const readAdf = () =>
    readValidatedPipelineAdf(fullPath, {
      // Chronos only registers pipeline files through its governed
      // scheduler path; make that trust decision explicit for the loader.
      trustResolved: true,
    });
  if (scope.kind === 'repository') return { scope, adf: readAdf() };
  assertRegisteredTenantPipeline(scope);
  return {
    scope,
    adf: withExecutionContext(CHRONOS_TENANT_RUNNER_ROLE, readAdf, undefined, scope.tenant_slug),
  };
}

function syncSchedulesFromAdf(): void {
  const root = pathResolver.rootDir();
  const pipelinesDir = path.join(root, 'pipelines');
  const files = collectPipelineFiles(pipelinesDir);
  const tenantFiles = collectTenantPipelineFiles(root);

  let registered = 0;
  for (const fullPath of [...files, ...tenantFiles.map((entry) => entry.file)]) {
    try {
      const { scope, adf } = readScheduledPipelineAdf(fullPath);
      if (!adf.schedule?.cron) continue;
      // Refuse to schedule a tenant pipeline whose runtime needs exceed its
      // tenant allowlist or the global ceiling (re-checked at run time too).
      if (scope.kind === 'tenant') resolveTenantRuntimeEnv(scope, adf.runtime);

      const sched = adf.schedule;
      const baseId = sched.id ?? path.basename(fullPath, '.json');
      // Tenant schedules are namespaced so a tenant file can never shadow a
      // repository schedule id (or another tenant's).
      const id = scope.kind === 'tenant' ? `tenant-${scope.tenant_slug}-${baseId}` : baseId;

      registerScheduledPipeline({
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
        // Tenant ADF context stays in the confidential file; the child reads it.
        context: scope.kind === 'tenant' ? {} : (adf.context ?? {}),
        deliver_to: sched.deliver_to,
      });
      registered++;
    } catch (err: any) {
      logger.warn(
        `[CHRONOS] Skipped ${path.relative(pathResolver.rootDir(), fullPath)}: ${err.message}`
      );
    }
  }

  if (registered > 0) {
    logger.info(`[CHRONOS] Synced ${registered} scheduled pipeline(s) from pipelines/`);
  }
}

// ---------------------------------------------------------------------------
// Tick: find due pipelines and run them
// ---------------------------------------------------------------------------

async function tickAsLeader(): Promise<void> {
  const now = new Date();
  recordDaemonHeartbeat('chronos-daemon', {
    status: 'running',
    details: { phase: 'tick' },
  });
  const due = getSchedulesDueNow(undefined, now);
  if (due.length === 0) return;

  logger.info(`[CHRONOS] ${due.length} pipeline(s) due`);

  for (const scheduled of due) {
    const minuteKey = now.toISOString().slice(0, 16);
    const receipt = await triggerRunner.run(
      {
        idempotencyKey: `cron:${scheduled.id}:${minuteKey}`,
        source: 'cron',
        createdBy: { authority_role: 'chronos_gateway', level: 40 },
        requestedAuthority: { authority_role: 'chronos_gateway', level: 40 },
        payload: {
          schedule_id: scheduled.id,
          fired_at: now.toISOString(),
          cron_runtime_context: {
            fresh_thread: true,
            persisted_between_fires: [
              'pipeline-schedules.json',
              'active/shared/runtime/trigger-deliveries.jsonl',
              'pipeline trace and run journal artifacts',
            ],
          },
        },
      },
      async ({ deliveryId }) => {
        const claimed = claimScheduledPipelineRun(scheduled.id, { now });
        if (!claimed || !claimed.runLock) {
          logger.info(`[CHRONOS] → Skipped: ${scheduled.id} (already running or no longer due)`);
          return `skipped:${scheduled.id}:${minuteKey}`;
        }

        const runToken = claimed.runLock.token;
        logger.info(`[CHRONOS] → Starting: ${scheduled.id}`);

        try {
          const resolvedPipelinePath = resolveScheduledPipelinePath(scheduled);
          const scope = assertChronosPipelinePath(resolvedPipelinePath);
          if (scope.kind === 'tenant') {
            // Re-verified at run time: a tenant suspended since registration,
            // or a path swapped for a symlink, is refused here.
            assertRegisteredTenantPipeline(scope);
            const trustApprovalId = requireTenantPipelineTrust(scope);
            const { adf: tenantAdf } = readScheduledPipelineAdf(resolvedPipelinePath);
            const runtimeEnv = resolveTenantRuntimeEnv(scope, tenantAdf.runtime);
            const status = await runTenantPipelineInChild(scope, trustApprovalId, runtimeEnv);
            if (status === 'failed') {
              // The catch below records the failure and raises the ops alert.
              throw new Error(`tenant pipeline run failed (${scope.relative})`);
            }
            completeScheduledPipelineRun(scheduled.id, runToken, 'succeeded', { now });
            logger.info(`[CHRONOS] ✓ ${scheduled.id}: succeeded (tenant ${scope.tenant_slug})`);
            return `cron-run:${runToken}`;
          }
          const adf = readValidatedPipelineAdf(resolvedPipelinePath, {
            trustResolved: true,
          });
          // WI-13: traces built during this run are tagged origin `scheduled`
          // through the trigger runner's async-scoped cron correlation
          // (`withTriggerCorrelation`, read by `deriveTraceOrigin`), not via a
          // process-env flip: ticks fire from an un-awaited setInterval, so
          // runs of different schedules can overlap in this process, and
          // secure-io child processes never inherit non-allowlisted env.
          const result = await runSteps(
            adf.steps,
            {
              ...(scheduled.context ?? {}),
              ...(adf.context ?? {}),
              cron_runtime_context: {
                trigger_id: deliveryId,
                fired_at: now.toISOString(),
                fresh_thread: true,
                persisted_between_fires: [
                  'pipeline-schedules.json',
                  'active/shared/runtime/trigger-deliveries.jsonl',
                  'pipeline trace and run journal artifacts',
                ],
              },
            },
            { pipelinePath: resolvedPipelinePath, runId: deliveryId }
          );

          let deliverySucceeded = true;
          if (result.status === 'succeeded' && scheduled.deliver_to) {
            try {
              const messageId = enqueueChronosDelivery({
                scheduleId: scheduled.id,
                pipelineName: scheduled.name,
                runId: deliveryId,
                status: result.status,
                context: result.context,
                target: validateChronosDeliveryTarget(
                  scheduled.deliver_to as ChronosDeliveryTarget
                ),
              });
              logger.info(`[CHRONOS] ✓ ${scheduled.id}: direct delivery queued (${messageId})`);
            } catch (deliveryError: any) {
              deliverySucceeded = false;
              logger.error(
                `[CHRONOS] ✗ ${scheduled.id}: direct delivery failed: ${deliveryError.message}`
              );
              sendOpsAlert({
                severity: 'warning',
                title: 'Scheduled pipeline delivery failed',
                context: {
                  daemon_id: 'chronos-daemon',
                  schedule_id: scheduled.id,
                  delivery: scheduled.deliver_to,
                  error: deliveryError?.message ?? String(deliveryError),
                },
                recommendation:
                  'Inspect the target surface outbox and schedule deliver_to contract.',
                dedupe_key: `chronos:${scheduled.id}:delivery-failed`,
              });
            }
          }

          completeScheduledPipelineRun(
            scheduled.id,
            runToken,
            result.status === 'succeeded' && deliverySucceeded ? 'succeeded' : 'failed',
            { now }
          );
          logger.info(`[CHRONOS] ✓ ${scheduled.id}: ${result.status}`);
          return `cron-run:${runToken}`;
        } catch (err: any) {
          completeScheduledPipelineRun(scheduled.id, runToken, 'failed', { now });
          logger.error(`[CHRONOS] ✗ ${scheduled.id}: ${err.message}`);
          sendOpsAlert({
            severity: 'warning',
            title: 'Scheduled pipeline failed',
            context: {
              daemon_id: 'chronos-daemon',
              schedule_id: scheduled.id,
              pipeline_path: scheduled.pipelinePath,
              error: err?.message ?? String(err),
            },
            recommendation: 'Inspect the pipeline trace and rerun the failed scheduled pipeline.',
            dedupe_key: `chronos:${scheduled.id}:failed`,
          });
          throw err;
        }
      }
    );
    if (receipt.status === 'failed' || receipt.status === 'rejected') {
      logger.warn(
        `[CHRONOS] Trigger ${scheduled.id} ${receipt.status}: ${receipt.reason || 'unknown'}`
      );
    }
  }
}

async function tick(): Promise<void> {
  const result = await withTriggerLeaderLease('chronos-daemon', () =>
    withExecutionContextAsync('chronos_gateway', tickAsLeader)
  );
  if (result === undefined) {
    logger.info('[CHRONOS] Another scheduler leader owns this tick; skipping.');
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(_args: string[] = []): Promise<void> {
  logger.info('[CHRONOS] Kyberion Pipeline Scheduler starting...');
  recordDaemonHeartbeat('chronos-daemon', {
    status: 'starting',
    details: { tick_interval_ms: TICK_INTERVAL_MS },
  });

  syncSchedulesFromAdf();

  // First tick immediately on startup
  await tick();

  setInterval(async () => {
    try {
      syncSchedulesFromAdf(); // picks up new/changed schedule fields
      await tick();
    } catch (err: any) {
      logger.error(`[CHRONOS] Tick error: ${err.message}`);
    }
  }, TICK_INTERVAL_MS);

  recordDaemonHeartbeat('chronos-daemon', {
    status: 'running',
    details: { tick_interval_ms: TICK_INTERVAL_MS },
  });
  logger.info(`[CHRONOS] Running. Tick interval: ${TICK_INTERVAL_MS / 1000}s`);
}

const runChronosDaemon = defineScript({
  name: 'chronos:daemon',
  flags: [],
  run: async ({ argv }) => {
    try {
      await main(argv);
    } catch (err: any) {
      const message = `[CHRONOS] Fatal: ${err?.message ?? String(err)}`;
      recordDaemonHeartbeat('chronos-daemon', {
        status: 'error',
        details: { error: err?.message ?? String(err) },
      });
      sendOpsAlert({
        severity: 'critical',
        title: 'Chronos daemon fatal error',
        context: { daemon_id: 'chronos-daemon', error: err?.message ?? String(err) },
        recommendation:
          'Restart chronos and inspect active/shared/logs/traces for the last failure.',
        dedupe_key: 'chronos-daemon:fatal',
      });
      throw new ScriptExitError(1, message);
    }
  },
});

if (
  isDirectScript(import.meta.url, 'chronos_daemon.ts') ||
  isDirectScript(import.meta.url, 'chronos_daemon.js')
) {
  void runChronosDaemon();
}
