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
import { readConfiguredActorIdentity } from '@agent/core/identity-context-bridge';
import { pathResolver } from '@agent/core/path-resolver';
import { recordDaemonHeartbeat, type DaemonHeartbeat } from '@agent/core/daemon-heartbeat';
import { recordDaemonStart } from '@agent/core/ops-health-state';
import { recordRuntimeHealthSample } from '@agent/core/tool/runtime-health-history';
import { safeExistsSync, safeLstat, safeReaddir } from '@agent/core/secure-io';
import { parseSafeJsonInput } from '@agent/core/foundation/safe-json';
import { sendOpsAlert } from '@agent/core/ops-alert';
import {
  resolveScheduledPipelinePath,
  getSchedulesDueNow,
  claimScheduledPipelineRun,
  completeScheduledPipelineRun,
  listOperatorExcludedSchedules,
  listScheduledPipelines,
} from '@agent/core/pipeline-scheduler';
import {
  enqueueChronosDelivery,
  validateChronosDeliveryTarget,
} from '@agent/core/chronos-delivery';
import {
  createTriggerRunner,
  releaseTriggerLeaderLease,
  withTriggerLeaderLease,
} from '@agent/core/trigger-runner';
import { sweepAwaitStateRuns } from '@agent/core/pipeline/pipeline-await-resume';
import { executeServicePreset } from '@agent/core/service/service-engine';
import { withExecutionContext, withExecutionContextAsync } from '@agent/core/authority';
import { listTenantProfileSlugs, resolveTenant } from '@agent/core/organization/tenant-registry';
import { isValidTenantSlug } from '@agent/core/entity-scope';
import { assertSafeRepositoryPath, safeExecResultAsync, safeReadFile } from '@agent/core/secure-io';
import { loadServiceEndpointsCatalog } from '@agent/core/service/service-endpoint-registry';
import { loadReasoningBackendPolicy } from '@agent/core/reasoning/reasoning-backend-policy';
import { findValidProjectTrustApproval } from '@agent/core/project/project-trust';
import type { ChronosDeliveryTarget } from '@agent/core/chronos-delivery';
import { readValidatedPipelineAdf } from './refactor/adf-input.js';
import { runSteps } from './run_pipeline.js';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';
import {
  syncScheduleRegistry,
  type ScheduleRegistrySyncResult,
} from './lib/schedule-registry-sync.js';
import {
  installGracefulShutdown,
  startSerialTickLoop,
  type ImmediateExitRequest,
  type SerialTickStopOutcome,
  type ShutdownSignal,
} from './lib/daemon-loop.js';

const TICK_INTERVAL_MS = 60_000;
/** Bound on waiting for an in-flight tick during SIGTERM/SIGINT shutdown. */
const SHUTDOWN_GRACE_MS = 30_000;
const triggerRunner = createTriggerRunner();

/**
 * Schedules whose ops are sovereign-only (cross-tenant aggregation). The
 * chronos_gateway role binds persona `worker` into the execution scope, which
 * outranks the process env, so these run under an explicit sovereign scope —
 * but only when the operator started the daemon with KYBERION_PERSONA=sovereign.
 * Adding an id here is a privilege decision; keep the list minimal.
 */
const SOVEREIGN_SCHEDULE_IDS: ReadonlySet<string> = new Set(['organization-daily-digest']);

function sovereignPersonaFor(scheduleId: string): 'sovereign' | undefined {
  return SOVEREIGN_SCHEDULE_IDS.has(scheduleId) &&
    readConfiguredActorIdentity().persona === 'sovereign'
    ? 'sovereign'
    : undefined;
}

// ---------------------------------------------------------------------------
// ADF scan → registry sync
// ---------------------------------------------------------------------------

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
      // Routine skip (logging-policy: quiet by default) — debug, not info.
      logger.debug(`[CHRONOS] tenant ${slug} pipelines not scanned: ${err?.message ?? err}`);
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
      return parseSafeJsonInput(
        String(safeReadFile(file, { encoding: 'utf8' })),
        `tenant runtime allowlist ${relative}`
      ) as TenantRuntimeAllowlist;
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
  /** null when the file is valid JSON but not a pipeline ADF (e.g. a design
   *  protocol document sharing the directory) — the caller skips it quietly. */
  adf: any;
} {
  const scope = assertChronosPipelinePath(fullPath);
  const readAdf = () => {
    // Only `action: 'pipeline'` documents are ADF pipelines. Data files under
    // pipelines/ (e.g. PPTX design protocols listed in pipeline-adf-contract's
    // KNOWN_DATA_FILES) fail schema validation by design; warning about them
    // on every tick is noise, so they are skipped before validation.
    const parsed = parseSafeJsonInput(
      String(safeReadFile(fullPath, { encoding: 'utf8' })),
      fullPath
    ) as Record<string, unknown> | null;
    if (!parsed || parsed.action !== 'pipeline') return null;
    return readValidatedPipelineAdf(fullPath, {
      // Chronos only registers pipeline files through its governed
      // scheduler path; make that trust decision explicit for the loader.
      trustResolved: true,
    });
  };
  if (scope.kind === 'repository') return { scope, adf: readAdf() };
  assertRegisteredTenantPipeline(scope);
  return {
    scope,
    adf: withExecutionContext(CHRONOS_TENANT_RUNNER_ROLE, readAdf, undefined, scope.tenant_slug),
  };
}

/** Make this instance's explicit schedule ownership visible. */
function warnOperatorExcludedSchedules(): void {
  const excluded = listOperatorExcludedSchedules(listScheduledPipelines());
  if (excluded.length === 0) return;
  logger.info(
    `[CHRONOS] this instance excludes ${excluded.length} enabled schedule(s) by its explicit allowlist — plain KYBERION_CHRONOS_SCHEDULES ids partition job ownership | next: confirm these jobs belong to another instance; use +ID only when additive execution is intended | evidence: ${excluded.slice(0, 10).join(', ')}${excluded.length > 10 ? ', …' : ''}`
  );
}

/**
 * ADF `schedule` fields → schedule registry, with this daemon's tenant gates.
 * Exported so `pnpm kyberion scheduler reconcile` can sync without the daemon.
 */
export function syncSchedulesFromAdf(
  options: { dryRun?: boolean } = {}
): ScheduleRegistrySyncResult {
  return syncScheduleRegistry({
    collectTenantPipelineFiles,
    readScheduledPipelineAdf,
    assertTenantRuntime: (scope, runtime) => void resolveTenantRuntimeEnv(scope, runtime),
    dryRun: options.dryRun,
  });
}

// ---------------------------------------------------------------------------
// Tick: find due pipelines and run them
// ---------------------------------------------------------------------------

// Identical await-state scan errors (a corrupt journal that stays corrupt,
// a schema mismatch that stays mismatched) recur on every tick. Warn once
// per runId+reason per window and count the suppressed repeats into the
// next emission so the log stays a signal, not a metronome.
const awaitScanErrorState = new Map<string, { count: number; lastWarnAt: number }>();

/** Re-warn window for an identical await-state scan error. */
const AWAIT_SCAN_ERROR_WINDOW_MS = 60 * 60 * 1000;

/** Test hook. */
export function resetAwaitScanErrorDedupForTests(): void {
  awaitScanErrorState.clear();
}

function reportAwaitScanError(runId: string, reason: string | undefined): void {
  const key = `${runId} ${reason ?? ''}`;
  const now = Date.now();
  const seen = awaitScanErrorState.get(key);
  if (seen && now - seen.lastWarnAt < AWAIT_SCAN_ERROR_WINDOW_MS) {
    seen.count += 1;
    return;
  }
  const suppressed = seen?.count ?? 0;
  awaitScanErrorState.set(key, { count: 0, lastWarnAt: now });
  const suffix =
    suppressed > 0 ? ` (plus ×${suppressed} identical suppressed in the last hour)` : '';
  logger.warn(`[CHRONOS] await-state scan error for ${runId}: ${reason}${suffix}`);
}

// ---------------------------------------------------------------------------
// Heartbeat: liveness that a crash loop cannot fake. Every write carries the
// process start time, rolling restart counters (ops-health crash-loop
// finding) and the last tick outcome. `last_tick_ok_at` moves only AFTER a
// tick completes; a long tick refreshes the heartbeat as `tick_in_progress`.
// ---------------------------------------------------------------------------

const chronosLiveness: Record<string, unknown> = {};

function writeChronosHeartbeat(
  status: DaemonHeartbeat['status'],
  details: Record<string, unknown> = {}
): void {
  recordDaemonHeartbeat('chronos-daemon', { status, details: { ...chronosLiveness, ...details } });
}

/**
 * How often a running tick refreshes the heartbeat. A scheduled run can last
 * hours (a backup archive is allowed up to 6h), and a heartbeat written only
 * after the tick would go stale mid-run: baseline L10 would raise a false
 * alarm and the watchdog could kickstart chronos in the middle of the run.
 */
export const TICK_HEARTBEAT_REFRESH_MS = 60_000;

function lastTickFailed(liveness: Record<string, unknown>): boolean {
  const errorAt =
    typeof liveness.last_tick_error_at === 'string' ? Date.parse(liveness.last_tick_error_at) : NaN;
  if (!Number.isFinite(errorAt)) return false;
  const okAt =
    typeof liveness.last_tick_ok_at === 'string' ? Date.parse(liveness.last_tick_ok_at) : NaN;
  return !Number.isFinite(okAt) || errorAt > okAt;
}

/**
 * Run one leader tick and record its outcome in the heartbeat. While the tick
 * runs, the heartbeat is refreshed every `refreshMs` with phase
 * `tick_in_progress` and the tick start (readDaemonHeartbeat flags a tick in
 * progress past DAEMON_TICK_IN_PROGRESS_MAX_MS); `last_tick_ok_at` still moves
 * only when a tick completes. A tick shorter than `refreshMs` writes nothing
 * until it settles, so a tick that throws every minute cannot keep the
 * heartbeat fresh. The lease attempt is a single try, so a standby process
 * settles long before the first refresh.
 */
export async function runTickWithHeartbeat(
  run: () => Promise<boolean>,
  write: (
    status: DaemonHeartbeat['status'],
    details: Record<string, unknown>
  ) => void = writeChronosHeartbeat,
  liveness: Record<string, unknown> = chronosLiveness,
  now: () => Date = () => new Date(),
  refreshMs: number = TICK_HEARTBEAT_REFRESH_MS
): Promise<void> {
  const tickStartedAt = now().toISOString();
  const refresh = setInterval(() => {
    try {
      write(lastTickFailed(liveness) ? 'error' : 'running', {
        phase: 'tick_in_progress',
        tick_started_at: tickStartedAt,
      });
    } catch (error) {
      logger.warn(
        `[CHRONOS] in-progress heartbeat write failed — ${
          error instanceof Error ? error.message : String(error)
        } | next: the tick continues; check active/shared/runtime/heartbeats is writable`
      );
    }
  }, refreshMs);
  refresh.unref?.();
  try {
    const led = await run();
    if (!led) return;
    liveness.last_tick_ok_at = now().toISOString();
    write('running', { phase: 'tick' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    liveness.last_tick_error = message.slice(0, 500);
    liveness.last_tick_error_at = now().toISOString();
    write('error', { phase: 'tick' });
    throw error;
  } finally {
    clearInterval(refresh);
  }
}

async function tickAsLeader(): Promise<void> {
  const now = new Date();
  // Await-state resume scan runs on every tick — a suspended pipeline has no
  // writer event to hook, so this sweep is its alarm clock. A scanner failure
  // warns but never stops the schedule work below.
  try {
    const outcomes = await sweepAwaitStateRuns({
      serviceCall: (input) =>
        executeServicePreset(input.service_id, input.action, input.params ?? {}, 'secret-guard'),
    });
    for (const outcome of outcomes) {
      if (outcome.status === 'resumed') {
        logger.info(`[CHRONOS] await-state resume spawned: ${outcome.runId} (${outcome.reason})`);
      } else if (outcome.status === 'error') {
        reportAwaitScanError(outcome.runId, outcome.reason);
      }
    }
  } catch (error) {
    logger.warn(
      `[CHRONOS] await-state sweep failed: ${error instanceof Error ? error.message : error}`
    );
  }
  const due = getSchedulesDueNow(undefined, now);
  if (due.length === 0) return;

  logger.info(`[CHRONOS] ${due.length} pipeline(s) due`);

  for (const scheduled of due) {
    const minuteKey = now.toISOString().slice(0, 16);
    const pendingReceipt = triggerRunner.run(
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
          const runScheduledSteps = () =>
            runSteps(
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
          const sovereign = sovereignPersonaFor(scheduled.id);
          const result = sovereign
            ? await withExecutionContextAsync('chronos_gateway', runScheduledSteps, sovereign)
            : await runScheduledSteps();

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
    // One failing trigger (e.g. an unreadable delivery journal) must not abort
    // the remaining schedules or escape the tick and crash the daemon.
    const receipt = await pendingReceipt.catch((error: unknown) => {
      logger.warn(
        `[CHRONOS] trigger ${scheduled.id} could not run — ${
          error instanceof Error ? error.message : String(error)
        } | next: the remaining schedules continue; this one retries next tick | evidence: cron:${scheduled.id}:${minuteKey}`
      );
      return null;
    });
    if (!receipt) continue;
    if (receipt.status === 'failed' || receipt.status === 'rejected') {
      logger.warn(
        `[CHRONOS] Trigger ${scheduled.id} ${receipt.status}: ${receipt.reason || 'unknown'}`
      );
    }
  }
}

async function tick(): Promise<void> {
  // tickAsLeader resolves to void, so the lease result cannot signal "lost the
  // lease" by itself — that logged a false "another leader" line on every tick.
  await runTickWithHeartbeat(async () => {
    const result = await withTriggerLeaderLease('chronos-daemon', async () => {
      await withExecutionContextAsync('chronos_gateway', tickAsLeader);
      return 'led' as const;
    });
    if (result === undefined) {
      logger.info('[CHRONOS] Another scheduler leader owns this tick; skipping.');
      return false;
    }
    return true;
  });
}

export interface ChronosShutdownDeps {
  stopLoop: (graceMs: number) => Promise<SerialTickStopOutcome>;
  stopSampler: () => void;
  releaseLease: () => void;
  recordHeartbeat: (details: Record<string, unknown>) => void;
  graceMs?: number;
}

/**
 * SIGTERM/SIGINT routine. When the in-flight tick drained (or none ran) the
 * lease is already free and the process exits normally. When the tick timed
 * out it is abandoned but still running: the lease is released only as the
 * very last step before a synchronous exit, so no second chronos can take the
 * lease while this process may still execute scheduled work.
 */
export function createChronosShutdown(deps: ChronosShutdownDeps) {
  const graceMs = deps.graceMs ?? SHUTDOWN_GRACE_MS;
  return async (signal: ShutdownSignal): Promise<void | ImmediateExitRequest> => {
    deps.stopSampler();
    const inFlightTick = await deps.stopLoop(graceMs);
    deps.recordHeartbeat({ state: 'stopped', signal, in_flight_tick: inFlightTick });
    if (inFlightTick === 'timed_out') {
      logger.warn(
        `[CHRONOS] in-flight tick did not settle within ${graceMs}ms — abandoning it and exiting now | next: check the scheduled run state and rerun it if needed | evidence: ${signal}`
      );
      return { exitImmediately: true, beforeExit: deps.releaseLease };
    }
    // Defensive: withLock already released the lease when the tick settled.
    deps.releaseLease();
    logger.info(`[CHRONOS] Stopped (${signal}, in-flight tick: ${inFlightTick}).`);
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(_args: string[] = []): Promise<void> {
  recordRuntimeHealthSample({ processName: 'chronos-daemon' });
  const runtimeHealthSampler = setInterval(
    () => recordRuntimeHealthSample({ processName: 'chronos-daemon' }),
    60 * 60 * 1000
  );
  runtimeHealthSampler.unref?.();
  logger.info('[CHRONOS] Kyberion Pipeline Scheduler starting...');
  Object.assign(chronosLiveness, recordDaemonStart('chronos-daemon'));
  writeChronosHeartbeat('starting', { tick_interval_ms: TICK_INTERVAL_MS });

  syncSchedulesFromAdf();
  warnOperatorExcludedSchedules();

  // G09: a self-rescheduling loop with an in-flight guard — the next tick is
  // armed only after the previous one settles, so a slow tick is never raced
  // by the next one (which the leader lease then misreported as "another
  // scheduler leader owns this tick"). The first tick runs immediately and a
  // failure there stays fatal.
  let firstTickDone = false;
  const loop = startSerialTickLoop({
    intervalMs: TICK_INTERVAL_MS,
    tick: async () => {
      if (firstTickDone) syncSchedulesFromAdf(); // picks up new/changed schedule fields
      firstTickDone = true;
      await tick();
    },
    onError: (err: any) => logger.error(`[CHRONOS] Tick error: ${err?.message ?? String(err)}`),
  });
  installGracefulShutdown({
    name: 'chronos-daemon',
    shutdown: createChronosShutdown({
      stopLoop: (graceMs) => loop.stop(graceMs),
      stopSampler: () => clearInterval(runtimeHealthSampler),
      releaseLease: () => releaseTriggerLeaderLease('chronos-daemon'),
      recordHeartbeat: (details) => void writeChronosHeartbeat('stopping', details),
    }),
  });

  await loop.firstTick;

  if (!chronosLiveness.last_tick_error_at) {
    writeChronosHeartbeat('running', { tick_interval_ms: TICK_INTERVAL_MS });
  }
  logger.info(`[CHRONOS] Running. Tick interval: ${TICK_INTERVAL_MS / 1000}s`);
}

const CHRONOS_USAGE = `Usage: pnpm scheduler [--help]

Starts the Kyberion pipeline scheduler (chronos) in the FOREGROUND: runs an
immediate tick, then ticks every ${TICK_INTERVAL_MS / 1000}s while holding the
leader lease. Stop with SIGINT/SIGTERM for a graceful shutdown.

  --help, -h   show this usage (does NOT start the daemon)

Inspect scheduler health without starting it: \`pnpm kyberion doctor\`,
\`pnpm ops:alerts\`, or the baseline-check L10 layer.`;

const runChronosDaemon = defineScript({
  name: 'chronos:daemon',
  flags: [],
  run: async ({ argv, print }) => {
    if (argv.includes('--help') || argv.includes('-h')) {
      print(CHRONOS_USAGE);
      return;
    }
    try {
      await main(argv);
    } catch (err: any) {
      const message = `[CHRONOS] Fatal: ${err?.message ?? String(err)}`;
      writeChronosHeartbeat('error', { error: err?.message ?? String(err) });
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
  isDirectScript(import.meta.url, 'chronos_daemon.js') ||
  isDirectScript(import.meta.url, 'chronos_daemon.bundle.js')
) {
  void runChronosDaemon();
}
