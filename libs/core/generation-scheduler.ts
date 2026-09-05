import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { defineCatalog } from './foundation/governed-catalog.js';
import { nowIso } from './foundation/time.js';
import {
  assertSafeRepositoryPath,
  safeCopyFileSync,
  safeExistsSync,
  safeMkdir,
  safeReaddir,
  safeLstat,
  safeWriteFile,
} from './secure-io.js';
import type { GenerationSchedule } from './src/types/generation-schedule.js';
import { matchesCron, hasMissedCronOccurrence, sameZonedMinute } from './src/cron-utils.js';
import { pathResolver } from './path-resolver.js';
import { withExecutionContextAsync } from './authority.js';
import {
  createTriggerRunner,
  withTriggerLeaderLease,
  type TriggerRunner,
} from './trigger-runner.js';
import { logger } from './core.js';
import {
  eventScopeMatches,
  normalizeEventScope,
  type EventScope,
  type EventScopeInput,
} from './event-scope.js';
import { releaseGenerationQuota, reserveGenerationQuota } from './generation-quota.js';
import { resolveTenant } from './tenant-registry.js';
import { physicalScopedPath } from './physical-namespace.js';
import { settleGenerationProviderCost } from './generation-cost-settlement.js';

export const GENERATION_SCHEDULE_DIR = 'active/shared/runtime/media-generation/schedules';
export const GENERATION_ARTIFACT_ROOT = 'active/shared/runtime/media-generation/artifacts';

export type ScopedGenerationSchedule = GenerationSchedule & { scope: EventScope };

export interface GenerationScheduleTenantRegistryOptions {
  /** Test seam; production resolves the durable tenant registry. */
  resolveTenant?: (tenantSlug: string) => unknown;
}

function ensureScheduleDir(): void {
  if (!safeExistsSync(GENERATION_SCHEDULE_DIR)) {
    safeMkdir(GENERATION_SCHEDULE_DIR, { recursive: true });
  }
}

export function generationSchedulePath(scheduleId: string, scope?: EventScopeInput): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(scheduleId)) {
    throw new Error(`[GENERATION_SCHEDULE_ID_INVALID] invalid schedule_id '${scheduleId}'`);
  }
  return physicalScopedPath(
    GENERATION_SCHEDULE_DIR,
    scope || { scope_kind: 'system', tier: 'public' },
    `${scheduleId}.json`
  );
}

function scheduleFiles(root = pathResolver.resolve(GENERATION_SCHEDULE_DIR)): string[] {
  if (!safeExistsSync(root)) return [];
  return safeReaddir(root).flatMap((entry) => {
    const entryPath = path.join(root, entry);
    if (entry === '.quarantine') return [];
    const stat = safeLstat(entryPath);
    if (stat.isFile() && entry.endsWith('.json')) return [entryPath];
    if (stat.isDirectory()) return scheduleFiles(entryPath);
    return [];
  });
}

export function generationSchedulePaths(scheduleId: string): string[] {
  const suffix = `${scheduleId}.json`;
  return scheduleFiles().filter((file) => path.basename(file) === suffix);
}

export function findGenerationSchedulePath(scheduleId: string, scope?: EventScopeInput): string {
  if (scope) {
    return pathResolver.resolve(
      physicalScopedPath(GENERATION_SCHEDULE_DIR, normalizeEventScope(scope), `${scheduleId}.json`)
    );
  }
  const matches = generationSchedulePaths(scheduleId);
  if (matches.length > 1) {
    throw new Error(
      `[GENERATION_SCHEDULE_ID_AMBIGUOUS] schedule_id '${scheduleId}' exists in multiple namespaces; provide scope`
    );
  }
  return matches[0] || pathResolver.resolve(generationSchedulePath(scheduleId));
}

function resolveRootRelativePath(logicalPath?: string | null): string | null {
  if (!logicalPath) return null;
  return assertSafeRepositoryPath(pathResolver.rootResolve(logicalPath), {
    allowMissingLeaf: true,
  });
}

function scheduleScope(schedule: GenerationSchedule): EventScope {
  return normalizeEventScope(
    (schedule as GenerationSchedule & { scope?: EventScopeInput }).scope || {
      scope_kind: 'system',
      tier: 'public',
    }
  );
}

function tenantArtifactRoot(scope: EventScope, scheduleId: string): string | null {
  if (!scope.tenant_slug) return null;
  return assertSafeRepositoryPath(
    pathResolver.rootResolve(
      `${GENERATION_ARTIFACT_ROOT}/tenants/${scope.tenant_slug}/${scheduleId}`
    ),
    { allowMissingLeaf: true }
  );
}

function pathWithin(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertTenantDeliveryPath(
  scope: EventScope,
  scheduleId: string,
  target: string,
  label: string
): void {
  const root = tenantArtifactRoot(scope, scheduleId);
  if (!root || pathWithin(root, target)) return;
  throw new Error(
    `[GENERATION_SCOPE_PATH_DENIED] ${label} for tenant '${scope.tenant_slug}' must stay under '${path.relative(pathResolver.rootDir(), root)}'`
  );
}

function targetPathValues(value: unknown, seen = new Set<object>()): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const object = value as Record<string, unknown>;
  if (seen.has(object)) return [];
  seen.add(object);
  const targets: string[] = [];
  for (const [key, child] of Object.entries(object)) {
    if (
      ['target_path', 'targetPath', 'output_path', 'outputPath'].includes(key) &&
      typeof child === 'string' &&
      child.trim()
    ) {
      targets.push(child);
      continue;
    }
    targets.push(...targetPathValues(child, seen));
  }
  return targets;
}

export function resolveGenerationScheduleDeliveryPaths(schedule: GenerationSchedule): {
  artifactDir: string | null;
  latestAliasPath: string | null;
  schedulePath: string;
} {
  const scope = scheduleScope(schedule);
  const tenantRoot = tenantArtifactRoot(scope, schedule.schedule_id);
  const explicitArtifactDir = resolveRootRelativePath(
    schedule.delivery_policy?.artifact_dir ?? undefined
  );
  const artifactDir = explicitArtifactDir || tenantRoot;
  const latestAliasPath = resolveRootRelativePath(
    schedule.delivery_policy?.latest_alias_path ?? undefined
  );
  if (scope.tenant_slug) {
    if (artifactDir)
      assertTenantDeliveryPath(scope, schedule.schedule_id, artifactDir, 'artifact_dir');
    if (latestAliasPath) {
      assertTenantDeliveryPath(scope, schedule.schedule_id, latestAliasPath, 'latest_alias_path');
    }
    for (const target of targetPathValues(schedule.job_template?.params)) {
      assertTenantDeliveryPath(
        scope,
        schedule.schedule_id,
        resolveRootRelativePath(target) || target,
        'job_template target path'
      );
    }
  }
  return {
    artifactDir,
    latestAliasPath,
    schedulePath: physicalScopedPath(
      GENERATION_SCHEDULE_DIR,
      scope,
      `${schedule.schedule_id}.json`
    ),
  };
}

export function resolveGenerationScheduleWorkdir(schedule: GenerationSchedule): string {
  const { artifactDir, latestAliasPath } = resolveGenerationScheduleDeliveryPaths(schedule);
  if (artifactDir) return artifactDir;
  if (latestAliasPath) return path.dirname(latestAliasPath);

  return pathResolver.rootResolve(
    path.dirname(generationSchedulePath(schedule.schedule_id, scheduleScope(schedule)))
  );
}

export function readGenerationSchedule(logicalPath: string): GenerationSchedule {
  const safePath = assertSafeRepositoryPath(logicalPath, { allowMissingLeaf: false });
  if (!safeLstat(safePath).isFile()) {
    throw new Error(`[GENERATION_SCHEDULE] schedule must be a regular file: ${logicalPath}`);
  }
  const schedule = generationScheduleCatalogAtPath(safePath).load();
  return normalizeGenerationSchedule(schedule);
}

export function writeGenerationSchedule(schedule: GenerationSchedule): GenerationSchedule {
  ensureScheduleDir();
  const normalized = normalizeGenerationSchedule(schedule);
  const target = pathResolver.resolve(
    physicalScopedPath(GENERATION_SCHEDULE_DIR, normalized.scope, `${normalized.schedule_id}.json`)
  );
  safeMkdir(path.dirname(target), { recursive: true });
  const validated = generationScheduleCatalogAtPath(target).validate(normalized, target);
  safeWriteFile(target, JSON.stringify(validated, null, 2));
  return validated;
}

function normalizeGenerationSchedule(schedule: GenerationSchedule): ScopedGenerationSchedule {
  const normalized = {
    ...schedule,
    kind: 'generation-schedule' as const,
    scope: scheduleScope(schedule),
  } as ScopedGenerationSchedule;
  // Registration/read normalization is also the schedule delivery preflight.
  resolveGenerationScheduleDeliveryPaths(normalized);
  return normalized;
}

function generationScheduleCatalogAtPath(filePath: string) {
  return defineCatalog<GenerationSchedule>({
    id: 'generation-schedule',
    path: filePath,
    schema: pathResolver.knowledge('product/schemas/generation-schedule.schema.json'),
  });
}

export function assertGenerationScheduleTenantRegistered(
  schedule: GenerationSchedule,
  options: GenerationScheduleTenantRegistryOptions = {}
): void {
  const scope = scheduleScope(schedule);
  if (!scope.tenant_slug) return;
  (options.resolveTenant ?? resolveTenant)(scope.tenant_slug);
}

export function registerGenerationSchedule(
  sourcePath: string,
  options: GenerationScheduleTenantRegistryOptions = {}
): GenerationSchedule {
  const schedule = readGenerationSchedule(sourcePath);
  assertGenerationScheduleTenantRegistered(schedule, options);
  return writeGenerationSchedule({
    ...schedule,
    updated_at: nowIso(),
  });
}

export function listGenerationSchedules(
  options: { scope?: EventScopeInput } = {}
): GenerationSchedule[] {
  const filter = options.scope ? normalizeEventScope(options.scope) : undefined;
  if (!safeExistsSync(GENERATION_SCHEDULE_DIR)) return [];
  return scheduleFiles()
    .map((file) => readGenerationSchedule(file))
    .filter((schedule) => {
      if (!filter) return true;
      const scope = (schedule as ScopedGenerationSchedule).scope;
      return eventScopeMatches(scope, {
        scope_kind: filter.scope_kind,
        tenant_slug: filter.tenant_slug,
        organization_id: filter.organization_id,
        project_id: filter.project_id,
        mission_id: filter.mission_id,
        task_id: filter.task_id,
        session_id: filter.session_id,
      });
    })
    .sort((a, b) => a.schedule_id.localeCompare(b.schedule_id));
}

export interface GenerationScheduleRunLock {
  token: string;
  acquiredAt: string;
  expiresAt: string;
}

type GenerationScheduleRuntime = GenerationSchedule & {
  last_submitted_at?: string | null;
  run_lock?: GenerationScheduleRunLock | null;
};

/** EV-01: same lease window as the pipeline scheduler's runLock. */
export const GENERATION_RUN_LOCK_TTL_MS = 15 * 60 * 1000;

function runLockActive(
  lock: GenerationScheduleRunLock | null | undefined,
  now: Date,
  ttlMs = GENERATION_RUN_LOCK_TTL_MS
): boolean {
  if (!lock) return false;
  const acquiredAt = Date.parse(lock.acquiredAt);
  const expiresAt = Date.parse(lock.expiresAt);
  if (!Number.isFinite(acquiredAt) || !Number.isFinite(expiresAt)) return false;
  return expiresAt > now.getTime() && now.getTime() - acquiredAt < ttlMs;
}

export function isGenerationScheduleDue(schedule: GenerationSchedule, now = new Date()): boolean {
  if (!schedule.enabled) return false;
  const runtime = schedule as GenerationScheduleRuntime;
  // EV-01: a run already in flight is not due again. Without this a second
  // tick (or a second daemon) submits the same generation job twice.
  if (runLockActive(runtime.run_lock, now)) return false;

  const lastRunAt = runtime.last_submitted_at ?? schedule.created_at;
  const lastRun = lastRunAt ? new Date(lastRunAt) : null;

  if (schedule.trigger.type === 'interval') {
    const intervalMs = Number(schedule.trigger.interval_ms || 0);
    if (!intervalMs) return false;
    if (!lastRun) return true;
    return now.getTime() - lastRun.getTime() >= intervalMs;
  }

  if (schedule.trigger.type === 'cron') {
    const cronExpr = String(schedule.trigger.cron || '');
    const timezone = schedule.trigger.timezone;
    if (matchesCron(cronExpr, now, timezone)) {
      if (!lastRun) return true;
      // Avoid re-triggering within the same minute
      return !sameZonedMinute(lastRun, now, timezone);
    }
    // EV-01: recover an occurrence that fell inside a downtime window. The
    // pipeline scheduler already did this; without it a generation schedule
    // firing while the daemon was down was lost permanently.
    if (!lastRun) return false;
    return hasMissedCronOccurrence(cronExpr, lastRun, now, timezone);
  }

  return false;
}

/**
 * Take the run lock and stamp `last_submitted_at`, or return null when the
 * schedule is no longer due / already claimed. Mirrors
 * `claimScheduledPipelineRun` so both schedulers behave the same way.
 */
export function claimGenerationScheduleRun(
  scheduleId: string,
  now = new Date(),
  scope?: EventScopeInput
): GenerationScheduleRuntime | null {
  const logicalPath = findGenerationSchedulePath(scheduleId, scope);
  if (!safeExistsSync(logicalPath)) return null;
  const schedule = readGenerationSchedule(logicalPath) as GenerationScheduleRuntime;
  if (scope) {
    const filter = normalizeEventScope(scope);
    if (
      !eventScopeMatches((schedule as ScopedGenerationSchedule).scope, {
        scope_kind: filter.scope_kind,
        tenant_slug: filter.tenant_slug,
        organization_id: filter.organization_id,
        project_id: filter.project_id,
        mission_id: filter.mission_id,
        task_id: filter.task_id,
        session_id: filter.session_id,
      })
    )
      return null;
  }
  if (!isGenerationScheduleDue(schedule, now)) return null;

  const claimed: GenerationScheduleRuntime = {
    ...schedule,
    run_lock: {
      token: randomUUID(),
      acquiredAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + GENERATION_RUN_LOCK_TTL_MS).toISOString(),
    },
    last_submitted_at: now.toISOString(),
    updated_at: now.toISOString(),
  };
  writeGenerationSchedule(claimed);
  return claimed;
}

/** Release the run lock, but only for the holder of `token`. */
export function completeGenerationScheduleRun(
  scheduleId: string,
  token: string,
  status: 'submitted' | 'failed',
  now = new Date(),
  scope?: EventScopeInput
): GenerationScheduleRuntime | null {
  const logicalPath = findGenerationSchedulePath(scheduleId, scope);
  if (!safeExistsSync(logicalPath)) return null;
  const schedule = readGenerationSchedule(logicalPath) as GenerationScheduleRuntime;
  // A stale holder must not clear a lock that a later run already re-took.
  if (!schedule.run_lock || schedule.run_lock.token !== token) return null;

  const released: GenerationScheduleRuntime = {
    ...schedule,
    run_lock: null,
    last_job_status: status,
    updated_at: now.toISOString(),
  };
  writeGenerationSchedule(released);
  return released;
}

export function markGenerationScheduleSubmitted(
  schedule: GenerationSchedule,
  jobId: string,
  submittedAt = nowIso()
): GenerationSchedule {
  return writeGenerationSchedule({
    ...schedule,
    last_job_id: jobId,
    last_job_status: 'submitted',
    last_submitted_at: submittedAt,
    updated_at: submittedAt,
  });
}

export function markGenerationScheduleReconciled(
  schedule: GenerationSchedule,
  updates: Record<string, unknown>,
  updatedAt = nowIso()
): GenerationSchedule {
  return writeGenerationSchedule({
    ...schedule,
    ...updates,
    updated_at: updatedAt,
  });
}

type GenerationScheduleAction = 'list' | 'tick';

function normalizeGenerationScheduleId(value: string): string {
  return value.endsWith('.json') ? value.slice(0, -5) : value;
}

function generationTargetFormat(schedule: GenerationSchedule): string {
  const params = schedule.job_template?.params || {};
  const actionKey =
    schedule.job_template.action === 'generate_image'
      ? 'image_adf'
      : schedule.job_template.action === 'generate_video'
        ? 'video_adf'
        : schedule.job_template.action === 'generate_music'
          ? 'music_adf'
          : undefined;
  const adf = actionKey && params[actionKey];
  const output =
    adf && typeof adf === 'object' && !Array.isArray(adf)
      ? (adf as Record<string, any>).output
      : undefined;
  const explicit =
    typeof params.format === 'string'
      ? params.format
      : output && typeof output.format === 'string'
        ? output.format
        : undefined;
  if (explicit && /^[a-z0-9]{1,8}$/i.test(explicit)) return explicit.toLowerCase();
  return schedule.job_template.action === 'generate_image'
    ? 'png'
    : schedule.job_template.action === 'generate_video'
      ? 'mp4'
      : schedule.job_template.action === 'generate_music'
        ? 'mp3'
        : 'json';
}

function generationParamsForSchedule(schedule: GenerationSchedule): Record<string, unknown> {
  const params = { ...(schedule.job_template?.params || {}) };
  const scope = scheduleScope(schedule);
  if (!scope.tenant_slug || targetPathValues(params).length > 0) return params;
  const { artifactDir } = resolveGenerationScheduleDeliveryPaths(schedule);
  if (!artifactDir) return params;
  const target = pathResolver.toRepoRelative(
    path.join(artifactDir, `${schedule.schedule_id}.${generationTargetFormat(schedule)}`)
  );
  return { ...params, target_path: target };
}

function isTerminalGenerationJobStatus(status: unknown): boolean {
  return ['succeeded', 'failed', 'timed_out', 'canceled'].includes(String(status || ''));
}

export type MediaGenerationHandleAction = (request: {
  action: string;
  params: Record<string, unknown>;
}) => Promise<any>;

/**
 * EV-01: the actuator entry point, injectable.
 *
 * The tick logic used to be duplicated in `scripts/run_generation_schedule.ts`,
 * and the script's copy — the one the daemon actually ran — was testable only
 * because it imported the actuator statically. Now that there is one
 * implementation, it needs a seam of its own: the default path resolves the
 * built actuator through a dynamic file URL, which a test cannot intercept.
 */
export interface GenerationScheduleTickDeps {
  handleAction?: MediaGenerationHandleAction;
  runner?: TriggerRunner;
  now?: Date;
  /**
   * Leader lease identity. Defaults to the daemon's, which is the point in
   * production — one leader per host set. Tests override it so they do not
   * contend with each other (or with a real daemon) for a global,
   * intentionally non-blocking lease.
   */
  leaderId?: string;
  quota?: {
    reserve?: typeof reserveGenerationQuota;
    release?: typeof releaseGenerationQuota;
  };
  /** Test seam; production resolves the durable tenant registry. */
  resolveTenant?: (tenantSlug: string) => unknown;
}

export const GENERATION_SCHEDULE_LEADER_ID = 'generation-schedule-daemon';

async function loadMediaGenerationActuator() {
  return import(
    /* webpackIgnore: true */
    pathToFileURL(pathResolver.rootResolve('libs/actuators/media-generation-actuator/src/index.js'))
      .href
  );
}

async function resolveHandleAction(
  deps: GenerationScheduleTickDeps
): Promise<MediaGenerationHandleAction> {
  if (deps.handleAction) return deps.handleAction;
  const { handleAction } = await loadMediaGenerationActuator();
  return handleAction as MediaGenerationHandleAction;
}

async function getLastGenerationJobStatus(
  schedule: GenerationSchedule,
  deps: GenerationScheduleTickDeps = {}
): Promise<string | null> {
  if (!schedule.last_job_id) return null;
  try {
    const handleAction = await resolveHandleAction(deps);
    const job = await handleAction({
      action: 'get_generation_job',
      params: { job_id: schedule.last_job_id },
    });
    return job?.status || null;
  } catch {
    return null;
  }
}

async function reconcileGenerationSchedule(
  schedule: GenerationSchedule,
  deps: GenerationScheduleTickDeps = {}
): Promise<{ schedule: GenerationSchedule; outcome?: Record<string, unknown> }> {
  if (!schedule.last_job_id) return { schedule };

  const handleAction = await resolveHandleAction(deps);
  const job = await handleAction({
    action: 'get_generation_job',
    params: { job_id: schedule.last_job_id },
  });

  let aliasUpdated = false;
  const { artifactDir, latestAliasPath } = resolveGenerationScheduleDeliveryPaths(schedule);
  const workdir = resolveGenerationScheduleWorkdir(schedule);
  const copiedSource = job?.result?.copied_to || job?.request?.target_path;
  if (
    job?.status === 'succeeded' &&
    latestAliasPath &&
    copiedSource &&
    safeExistsSync(copiedSource)
  ) {
    safeMkdir(path.dirname(latestAliasPath), { recursive: true });
    safeCopyFileSync(path.resolve(copiedSource), latestAliasPath);
    aliasUpdated = true;
  }

  const updatedSchedule = markGenerationScheduleReconciled(schedule, {
    last_job_status: job?.status || schedule.last_job_status || null,
    last_completed_at: job?.completed_at || schedule.last_completed_at,
  });

  let costSettlement: Record<string, unknown> | null = null;
  if (isTerminalGenerationJobStatus(job?.status) && job?.job_id) {
    try {
      costSettlement = {
        ...settleGenerationProviderCost({
          job_id: String(job.job_id),
          action: String(job.action || schedule.job_template.action),
          status: String(job.status),
          scope: scheduleScope(schedule),
          provider: job.provider,
          result: job.result,
        }),
      };
    } catch (error) {
      costSettlement = {
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return {
    schedule: updatedSchedule,
    outcome: {
      schedule_id: schedule.schedule_id,
      reconciled_job_id: schedule.last_job_id,
      reconciled_status: job?.status || null,
      alias_updated: aliasUpdated,
      latest_alias_path: aliasUpdated ? latestAliasPath : null,
      artifact_dir: artifactDir,
      workdir,
      cost_settlement: costSettlement,
    },
  };
}

/**
 * EV-01: the governed authority for media-generation firings.
 *
 * `chronos_gateway` was not reusable here — it has no write scope over
 * `active/shared/runtime/media-generation/`, so borrowing it would have made
 * the authority snapshot a fiction.
 */
export const GENERATION_SCHEDULER_AUTHORITY = Object.freeze({
  authority_role: 'generation_scheduler',
  // Derived from the role's scope_classes (operations_runtime = 40); TriggerRunner
  // rejects the trigger if this drifts from the role registry.
  level: 40,
});

async function tickGenerationSchedule(
  schedule: GenerationSchedule,
  runner: TriggerRunner,
  now: Date,
  deps: GenerationScheduleTickDeps = {}
): Promise<Record<string, unknown>> {
  try {
    assertGenerationScheduleTenantRegistered(schedule, {
      resolveTenant: deps.resolveTenant,
    });
  } catch (error) {
    return {
      schedule_id: schedule.schedule_id,
      status: 'blocked',
      reason: 'tenant registry validation failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const reconciliation = await reconcileGenerationSchedule(schedule, deps);
  schedule = reconciliation.schedule;

  const dependencies = Array.isArray(schedule.execution_policy?.depends_on)
    ? schedule.execution_policy.depends_on
    : [];
  if (dependencies.length > 0) {
    const currentScope = scheduleScope(schedule);
    const dependencyStates = dependencies.map((scheduleId) => {
      try {
        const dependency = readGenerationSchedule(
          findGenerationSchedulePath(normalizeGenerationScheduleId(scheduleId), currentScope)
        );
        const dependencyScope = scheduleScope(dependency);
        const sameScope = eventScopeMatches(dependencyScope, {
          scope_kind: currentScope.scope_kind,
          tenant_slug: currentScope.tenant_slug,
          organization_id: currentScope.organization_id,
          project_id: currentScope.project_id,
          mission_id: currentScope.mission_id,
          task_id: currentScope.task_id,
          session_id: currentScope.session_id,
        });
        return sameScope ? dependency : null;
      } catch {
        return null;
      }
    });
    const unresolved = dependencyStates.filter(
      (dep) => !dep || dep.last_job_status !== 'succeeded'
    );
    if (unresolved.length > 0) {
      return {
        schedule_id: schedule.schedule_id,
        status: 'skipped',
        reason: 'dependencies are not yet satisfied',
        depends_on: dependencies,
        reconciliation: reconciliation.outcome || null,
      };
    }
  }

  const lastStatus = schedule.last_job_status || (await getLastGenerationJobStatus(schedule, deps));
  if (
    schedule.execution_policy?.concurrency === 'skip_if_running' &&
    (lastStatus === 'submitted' || lastStatus === 'running')
  ) {
    return {
      schedule_id: schedule.schedule_id,
      status: 'skipped',
      reason: 'previous job is still running',
      last_job_id: schedule.last_job_id,
      reconciliation: reconciliation.outcome || null,
    };
  }

  if (!isGenerationScheduleDue(schedule, now)) {
    return {
      schedule_id: schedule.schedule_id,
      status: 'skipped',
      reason: 'schedule is not due',
      last_job_id: schedule.last_job_id || null,
      reconciliation: reconciliation.outcome || null,
    };
  }

  // EV-01: every firing now goes through the same gate cron does — one
  // idempotency key per schedule-minute, an authority snapshot checked against
  // the role registry, and a delivery receipt in the audit chain. Two ticks in
  // the same minute (or two daemons) can no longer submit the job twice.
  const minuteKey = now.toISOString().slice(0, 16);
  let outcome: Record<string, unknown> | null = null;

  const receipt = await runner.run(
    {
      idempotencyKey: `gen:${schedule.schedule_id}:${minuteKey}`,
      source: 'cron',
      createdBy: { ...GENERATION_SCHEDULER_AUTHORITY },
      requestedAuthority: { ...GENERATION_SCHEDULER_AUTHORITY },
      payload: {
        schedule_id: schedule.schedule_id,
        fired_at: now.toISOString(),
      },
    },
    async ({ deliveryId }) => {
      const claimed = claimGenerationScheduleRun(
        schedule.schedule_id,
        now,
        (schedule as ScopedGenerationSchedule).scope
      );
      if (!claimed || !claimed.run_lock) {
        outcome = {
          schedule_id: schedule.schedule_id,
          status: 'skipped',
          reason: 'already running or no longer due',
          reconciliation: reconciliation.outcome || null,
        };
        return `skipped:${schedule.schedule_id}:${minuteKey}`;
      }
      const runToken = claimed.run_lock.token;
      const claimedScope = (claimed as ScopedGenerationSchedule).scope;
      const quotaReserve = deps.quota?.reserve ?? reserveGenerationQuota;
      const quotaRelease = deps.quota?.release ?? releaseGenerationQuota;
      let quota: ReturnType<typeof reserveGenerationQuota>;
      try {
        quota = quotaReserve(claimedScope, claimed.job_template.action);
      } catch (err) {
        completeGenerationScheduleRun(schedule.schedule_id, runToken, 'failed', now, claimedScope);
        throw err;
      }
      if (!quota.allowed) {
        completeGenerationScheduleRun(schedule.schedule_id, runToken, 'failed', now, claimedScope);
        outcome = {
          schedule_id: schedule.schedule_id,
          status: 'blocked',
          reason: 'generation quota exceeded',
          quota,
          reconciliation: reconciliation.outcome || null,
        };
        return `quota-blocked:${schedule.schedule_id}:${minuteKey}`;
      }
      let quotaCommitted = false;
      let quotaReleased = false;

      try {
        const handleAction = await resolveHandleAction(deps);
        const submittedJob = await handleAction({
          action: 'submit_generation',
          params: {
            action: claimed.job_template.action,
            params: generationParamsForSchedule(claimed),
            retry_policy: claimed.execution_policy?.retry_policy,
            scope: claimedScope,
          },
        });

        if (!submittedJob?.job_id) {
          if (quota.tenant_slug) {
            quotaRelease(claimedScope, claimed.job_template.action, {
              reservation_units: quota.units,
            });
            quotaReleased = true;
          }
          completeGenerationScheduleRun(
            schedule.schedule_id,
            runToken,
            'failed',
            now,
            claimedScope
          );
          outcome = {
            schedule_id: schedule.schedule_id,
            status: 'failed',
            reason: 'job submission did not return a job_id',
            reconciliation: reconciliation.outcome || null,
          };
          throw new Error('job submission did not return a job_id');
        }

        quotaCommitted = true;
        markGenerationScheduleSubmitted(claimed, submittedJob.job_id);
        completeGenerationScheduleRun(
          schedule.schedule_id,
          runToken,
          'submitted',
          now,
          claimedScope
        );
        outcome = {
          schedule_id: schedule.schedule_id,
          status: 'submitted',
          job_id: submittedJob.job_id,
          provider_prompt_id: submittedJob.provider?.prompt_id || null,
          trigger_delivery_id: deliveryId,
          reconciliation: reconciliation.outcome || null,
        };
        return `generation-run:${runToken}`;
      } catch (err) {
        if (quota.tenant_slug && !quotaCommitted && !quotaReleased) {
          quotaRelease(claimedScope, claimed.job_template.action, {
            reservation_units: quota.units,
          });
        }
        completeGenerationScheduleRun(schedule.schedule_id, runToken, 'failed', now, claimedScope);
        throw err;
      }
    }
  );

  if (outcome) return outcome;
  // No outcome means the delivery never ran: duplicate, rejected, or failed
  // before the claim. Report the receipt rather than inventing a status.
  return {
    schedule_id: schedule.schedule_id,
    status: receipt.status === 'duplicate' ? 'skipped' : 'failed',
    reason: receipt.reason || `trigger ${receipt.status}`,
    trigger_status: receipt.status,
    reconciliation: reconciliation.outcome || null,
  };
}

export async function runGenerationScheduleAction(argv: {
  action: GenerationScheduleAction;
  schedule?: string;
  scope?: EventScopeInput;
  /** Test seam; production callers omit this. See GenerationScheduleTickDeps. */
  deps?: GenerationScheduleTickDeps;
}): Promise<GenerationSchedule[] | { status: 'completed'; results: Record<string, unknown>[] }> {
  switch (argv.action) {
    case 'list':
      return listGenerationSchedules({ scope: argv.scope });
    case 'tick': {
      const deps = argv.deps ?? {};
      const now = deps.now ?? new Date();
      const runner = deps.runner ?? createTriggerRunner();
      // EV-01: one leader per tick. The daemon respawns this action every 60s,
      // and nothing previously stopped two hosts (or a manual CLI run racing
      // the daemon) from both firing the same schedule.
      const leaderResult = await withTriggerLeaderLease(
        deps.leaderId ?? GENERATION_SCHEDULE_LEADER_ID,
        () =>
          withExecutionContextAsync(GENERATION_SCHEDULER_AUTHORITY.authority_role, async () => {
            const schedules = argv.schedule
              ? [
                  readGenerationSchedule(
                    findGenerationSchedulePath(
                      normalizeGenerationScheduleId(String(argv.schedule)),
                      argv.scope
                    )
                  ),
                ]
              : listGenerationSchedules({ scope: argv.scope });
            const results: Record<string, unknown>[] = [];
            for (const schedule of schedules) {
              results.push(await tickGenerationSchedule(schedule, runner, now, deps));
            }
            return results;
          })
      );

      if (leaderResult === undefined) {
        logger.info('[generation-scheduler] another scheduler leader owns this tick; skipping.');
        return { status: 'completed', results: [] };
      }
      return { status: 'completed', results: leaderResult };
    }
    default:
      throw new Error(`Unsupported action: ${String(argv.action)}`);
  }
}
