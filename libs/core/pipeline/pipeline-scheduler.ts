import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { defineCatalog, type GovernedCatalog } from '../foundation/governed-catalog.js';
import { safeWriteFile, safeExistsSync } from '../secure-io.js';
import { logger } from '../core.js';
import { pathResolver } from '../path-resolver.js';
import { getRegisteredEnvText } from '../foundation/env.js';
import { matchesCron, hasMissedCronOccurrence, sameZonedMinute } from './cron-utils.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScheduledPipeline {
  id: string;
  name: string;
  pipelinePath: string; // path to pipeline ADF JSON
  actuator: string; // 'browser' | 'media' | 'system' | etc
  trigger: {
    type: 'cron' | 'interval';
    cron?: string; // 5-field cron expression
    intervalMs?: number;
    timezone?: string;
  };
  enabled: boolean;
  /** Owning synchronizer for declarative registry reconciliation. */
  managedBy?: string;
  /**
   * The schedule ships disabled (`schedule.enabled: false` in its pipeline)
   * and runs only on hosts whose KYBERION_CHRONOS_SCHEDULES names its id.
   * A schedule disabled any other way stays disabled regardless of the env.
   */
  optIn?: boolean;
  lastRun?: string;
  lastStatus?: 'succeeded' | 'failed';
  consecutiveFailures?: number;
  disabledReason?: string;
  disabledAt?: string;
  context?: Record<string, any>; // additional context to inject
  deliver_to?: {
    surface: string;
    channel: string;
    thread_ts?: string;
    template?: string;
  };
  runLock?: ScheduledPipelineRunLock;
}

export interface ScheduledPipelineRunLock {
  token: string;
  acquiredAt: string;
  expiresAt: string;
}

export interface PipelineScheduleRegistry {
  version: string;
  schedules: ScheduledPipeline[];
}

export interface PipelineSchedulerOptions {
  rootDir?: string;
  now?: Date;
  runLockTtlMs?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REGISTRY_PATH = 'active/shared/runtime/pipeline-schedules.json';
const REGISTRY_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/pipeline-schedule-registry.schema.json'
);
const DEFAULT_RUN_LOCK_TTL_MS = 15 * 60 * 1000;

function registryPath(options: PipelineSchedulerOptions = {}): string {
  return options.rootDir
    ? path.join(options.rootDir, 'active/shared/runtime/pipeline-schedules.json')
    : pathResolver.rootResolve(REGISTRY_PATH);
}

const registryCatalogs = new Map<string, GovernedCatalog<PipelineScheduleRegistry>>();

function registryCatalog(
  options: PipelineSchedulerOptions = {}
): GovernedCatalog<PipelineScheduleRegistry> {
  const filePath = registryPath(options);
  const cached = registryCatalogs.get(filePath);
  if (cached) return cached;
  const catalog = defineCatalog<PipelineScheduleRegistry>({
    id: 'pipeline-schedule-registry',
    path: filePath,
    schema: REGISTRY_SCHEMA_PATH,
  });
  registryCatalogs.set(filePath, catalog);
  return catalog;
}

function nowValue(options: PipelineSchedulerOptions = {}): Date {
  return options.now ?? new Date();
}

function runLockTtlMs(options: PipelineSchedulerOptions = {}): number {
  return options.runLockTtlMs ?? DEFAULT_RUN_LOCK_TTL_MS;
}

function runLockActive(
  lock: ScheduledPipelineRunLock | undefined,
  now: Date,
  ttlMs: number
): boolean {
  if (!lock) return false;
  const acquiredAt = new Date(lock.acquiredAt).getTime();
  const expiresAt = new Date(lock.expiresAt).getTime();
  if (!Number.isFinite(acquiredAt) || !Number.isFinite(expiresAt)) return false;
  return expiresAt > now.getTime() && now.getTime() - acquiredAt < ttlMs;
}

// ---------------------------------------------------------------------------
// Registry CRUD
// ---------------------------------------------------------------------------

function ensureRegistryDir(options: PipelineSchedulerOptions = {}): void {
  const dir = path.dirname(registryPath(options));
  if (!safeExistsSync(dir)) {
    // Use dynamic import-free approach: write will create intermediates via secure-io
    // The registry file write itself handles existence
  }
}

export function loadScheduleRegistry(
  options: PipelineSchedulerOptions = {}
): PipelineScheduleRegistry {
  const filePath = registryPath(options);
  if (!safeExistsSync(filePath)) {
    return { version: '1.0', schedules: [] };
  }
  const parsed = registryCatalog(options).load();
  const schedules = (parsed.schedules || []).map((schedule) => ({
    ...schedule,
    pipelinePath: normalizeScheduledPipelinePath(schedule.pipelinePath, options.rootDir),
  }));
  return { ...parsed, schedules };
}

export function saveScheduleRegistry(
  registry: PipelineScheduleRegistry,
  options: PipelineSchedulerOptions = {}
): void {
  ensureRegistryDir(options);
  const normalizedRegistry: PipelineScheduleRegistry = {
    ...registry,
    schedules: registry.schedules.map((schedule) => ({
      ...schedule,
      pipelinePath: normalizeScheduledPipelinePath(schedule.pipelinePath, options.rootDir),
    })),
  };
  const validated = registryCatalog(options).validate(normalizedRegistry, registryPath(options));
  safeWriteFile(registryPath(options), JSON.stringify(validated, null, 2));
  logger.info(
    `[PIPELINE-SCHEDULER] Registry saved with ${normalizedRegistry.schedules.length} schedule(s)`
  );
}

/**
 * QM-02: the registry must stay host-portable — a schedule registered on one
 * machine (or repo checkout path) has to keep firing after the repo moves.
 * Absolute paths inside the repo root are stored repo-relative; legacy
 * absolute paths from another checkout are migrated via their `pipelines/`
 * segment; anything else is rejected rather than silently frozen to one host.
 */
export function normalizeScheduledPipelinePath(pipelinePath: string, rootDir?: string): string {
  const root = rootDir ?? pathResolver.rootDir();
  const trimmed = String(pipelinePath || '').trim();
  if (!trimmed) throw new Error('pipelinePath must be a non-empty path');
  const normalized = trimmed.replace(/\\/g, '/');
  const assertRepoRelative = (candidate: string): string => {
    const resolvedRoot = path.resolve(root);
    const resolved = path.resolve(resolvedRoot, candidate);
    const relative = path.relative(resolvedRoot, resolved);
    if (
      !relative ||
      relative === '..' ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new Error(
        `pipelinePath must be repo-relative or inside the repo root (got path outside the repo: ${trimmed})`
      );
    }
    return candidate;
  };
  if (!path.isAbsolute(trimmed)) return assertRepoRelative(normalized);
  const relative = path.relative(root, trimmed);
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
    return assertRepoRelative(relative.replace(/\\/g, '/'));
  }
  const marker = `${path.sep}pipelines${path.sep}`;
  const markerIndex = trimmed.indexOf(marker);
  if (markerIndex >= 0) {
    const migrated = trimmed.slice(markerIndex + 1).replace(/\\/g, '/');
    assertRepoRelative(migrated);
    logger.warn(
      `[PIPELINE-SCHEDULER] migrated legacy absolute pipelinePath to repo-relative: ${trimmed} -> ${migrated}`
    );
    return migrated;
  }
  throw new Error(
    `pipelinePath must be repo-relative or inside the repo root (got absolute path outside the repo: ${trimmed})`
  );
}

export function resolveScheduledPipelinePath(
  schedule: Pick<ScheduledPipeline, 'pipelinePath'>,
  options: PipelineSchedulerOptions = {}
): string {
  const root = options.rootDir ?? pathResolver.rootDir();
  const stored = normalizeScheduledPipelinePath(schedule.pipelinePath, root);
  return path.join(root, stored);
}

export function registerScheduledPipeline(
  pipeline: ScheduledPipeline,
  options: PipelineSchedulerOptions = {}
): void {
  pipeline = {
    ...pipeline,
    pipelinePath: normalizeScheduledPipelinePath(pipeline.pipelinePath, options.rootDir),
  };
  const registry = loadScheduleRegistry(options);
  const existingIndex = registry.schedules.findIndex((s) => s.id === pipeline.id);
  if (existingIndex >= 0) {
    const existing = registry.schedules[existingIndex];
    registry.schedules[existingIndex] = {
      ...existing,
      ...pipeline,
      lastRun: pipeline.lastRun ?? existing.lastRun,
      lastStatus: pipeline.lastStatus ?? existing.lastStatus,
      runLock: pipeline.runLock ?? existing.runLock,
    };
    logger.info(`[PIPELINE-SCHEDULER] Updated schedule: ${pipeline.id}`);
  } else {
    registry.schedules.push(pipeline);
    logger.info(`[PIPELINE-SCHEDULER] Registered new schedule: ${pipeline.id}`);
  }
  saveScheduleRegistry(registry, options);
}

/**
 * Reconcile one declarative schedule source with a single registry read/write.
 * Runtime execution state is retained for matching ids; unrelated schedules
 * registered by other surfaces are left untouched.
 */
export function reconcileScheduledPipelines(
  source: string,
  pipelines: ScheduledPipeline[],
  options: PipelineSchedulerOptions = {}
): { added: number; updated: number; removed: number; unchanged: number } {
  if (!source.trim()) throw new Error('schedule reconciliation source is required');

  const desired = new Map<string, ScheduledPipeline>();
  for (const pipeline of pipelines) {
    const normalized = {
      ...pipeline,
      pipelinePath: normalizeScheduledPipelinePath(pipeline.pipelinePath, options.rootDir),
      managedBy: source,
    };
    if (desired.has(normalized.id)) {
      throw new Error(
        `duplicate schedule id in reconciliation source '${source}': ${normalized.id}`
      );
    }
    desired.set(normalized.id, normalized);
  }

  const registry = loadScheduleRegistry(options);
  const currentIds = new Set<string>();
  let added = 0;
  let updated = 0;
  let unchanged = 0;
  const schedules: ScheduledPipeline[] = [];

  for (const existing of registry.schedules) {
    const wanted = desired.get(existing.id);
    if (!wanted) {
      if (existing.managedBy === source) {
        continue;
      }
      schedules.push(existing);
      continue;
    }

    currentIds.add(existing.id);
    const reconciled = {
      ...existing,
      ...wanted,
      lastRun: wanted.lastRun ?? existing.lastRun,
      lastStatus: wanted.lastStatus ?? existing.lastStatus,
      runLock: wanted.runLock ?? existing.runLock,
    };
    schedules.push(reconciled);
    if (JSON.stringify(existing) === JSON.stringify(reconciled)) unchanged += 1;
    else updated += 1;
  }

  for (const [id, pipeline] of desired) {
    if (currentIds.has(id)) continue;
    schedules.push(pipeline);
    added += 1;
  }

  const retainedManagedCount = registry.schedules.filter(
    (schedule) => schedule.managedBy === source && desired.has(schedule.id)
  ).length;
  const removed =
    registry.schedules.filter((schedule) => schedule.managedBy === source).length -
    retainedManagedCount;
  const changed = added > 0 || updated > 0 || removed > 0;
  if (changed) saveScheduleRegistry({ ...registry, schedules }, options);

  return { added, updated, removed, unchanged };
}

export function unregisterScheduledPipeline(
  id: string,
  options: PipelineSchedulerOptions = {}
): void {
  const registry = loadScheduleRegistry(options);
  const before = registry.schedules.length;
  registry.schedules = registry.schedules.filter((s) => s.id !== id);
  if (registry.schedules.length < before) {
    saveScheduleRegistry(registry, options);
    logger.info(`[PIPELINE-SCHEDULER] Unregistered schedule: ${id}`);
  } else {
    logger.warn(`[PIPELINE-SCHEDULER] Schedule not found for unregister: ${id}`);
  }
}

export function listScheduledPipelines(
  options: PipelineSchedulerOptions = {}
): ScheduledPipeline[] {
  return loadScheduleRegistry(options).schedules;
}

/**
 * Returns all pipelines whose trigger matches the current time.
 * For cron triggers, matches the cron expression against `now`.
 * For interval triggers, checks elapsed time since lastRun.
 */
/**
 * Operator allowlist for this host: when KYBERION_CHRONOS_SCHEDULES lists
 * schedule ids (comma-separated), only those run. Registration still mirrors
 * every pipeline's `schedule`, so enabling another job is an env change, not
 * an edit to the pipeline files. Unset means every enabled schedule runs; a
 * set value that names no id (e.g. "," or blanks) fails closed and runs none.
 *
 * An id prefixed with `+` is an additive opt-in: it turns on a schedule that
 * ships disabled without restricting the others. A value made only of `+ids`
 * (e.g. "+organization-standup,+organization-retro") keeps every enabled
 * schedule running, so new schedules are not silently dropped by a host that
 * only wanted to opt into a few.
 */
export function scheduleAllowedByOperator(
  scheduleId: string,
  allowlist = getRegisteredEnvText('KYBERION_CHRONOS_SCHEDULES')
): boolean {
  if (allowlist === undefined || allowlist === '') return true;
  const { restrict, additive } = parseScheduleAllowlist(allowlist);
  if (restrict.length === 0 && additive.length > 0) return true;
  return restrict.includes(scheduleId) || additive.includes(scheduleId);
}

/**
 * Opt-in for schedules that ship disabled: only an explicit mention of the id
 * in KYBERION_CHRONOS_SCHEDULES (plain or `+`-prefixed) turns them on (an
 * unset env never does).
 */
export function scheduleExplicitlyOptedIn(
  scheduleId: string,
  allowlist = getRegisteredEnvText('KYBERION_CHRONOS_SCHEDULES')
): boolean {
  if (!allowlist) return false;
  const { restrict, additive } = parseScheduleAllowlist(allowlist);
  return restrict.includes(scheduleId) || additive.includes(scheduleId);
}

function parseScheduleAllowlist(allowlist: string): { restrict: string[]; additive: string[] } {
  const entries = allowlist
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return {
    restrict: entries.filter((entry) => !entry.startsWith('+')),
    additive: entries
      .filter((entry) => entry.startsWith('+'))
      .map((entry) => entry.slice(1).trim())
      .filter(Boolean),
  };
}

export function isScheduledPipelineDue(
  schedule: ScheduledPipeline,
  timezone?: string,
  now = new Date(),
  options: PipelineSchedulerOptions = {}
): boolean {
  if (!schedule.enabled && !(schedule.optIn && scheduleExplicitlyOptedIn(schedule.id)))
    return false;
  if (!scheduleAllowedByOperator(schedule.id)) return false;
  if (runLockActive(schedule.runLock, now, runLockTtlMs(options))) return false;

  if (schedule.trigger.type === 'interval') {
    const intervalMs = Number(schedule.trigger.intervalMs || 0);
    if (!intervalMs) return false;
    if (!schedule.lastRun) return true;
    const lastRunDate = new Date(schedule.lastRun);
    return now.getTime() - lastRunDate.getTime() >= intervalMs;
  }

  if (schedule.trigger.type === 'cron') {
    const cron = schedule.trigger.cron;
    if (!cron) return false;
    const tz = timezone || schedule.trigger.timezone;
    if (matchesCron(cron, now, tz)) {
      if (!schedule.lastRun) return true;
      return !sameZonedMinute(new Date(schedule.lastRun), now, tz);
    }
    if (!schedule.lastRun) return false;
    return hasMissedCronOccurrence(cron, new Date(schedule.lastRun), now, tz);
  }

  return false;
}

export function getSchedulesDueNow(
  timezone?: string,
  now = new Date(),
  options: PipelineSchedulerOptions = {}
): ScheduledPipeline[] {
  const registry = loadScheduleRegistry(options);
  return registry.schedules.filter((schedule) =>
    isScheduledPipelineDue(schedule, timezone, now, options)
  );
}

export function claimScheduledPipelineRun(
  id: string,
  options: PipelineSchedulerOptions = {}
): ScheduledPipeline | null {
  const now = nowValue(options);
  const ttlMs = runLockTtlMs(options);
  const registry = loadScheduleRegistry(options);
  const schedule = registry.schedules.find((entry) => entry.id === id);
  if (!schedule || !isScheduledPipelineDue(schedule, schedule.trigger.timezone, now, options))
    return null;
  if (runLockActive(schedule.runLock, now, ttlMs)) return null;

  const token = randomUUID();
  schedule.runLock = {
    token,
    acquiredAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
  };
  schedule.lastRun = now.toISOString();
  saveScheduleRegistry(registry, options);
  return schedule;
}

export function completeScheduledPipelineRun(
  id: string,
  token: string,
  status: 'succeeded' | 'failed',
  options: PipelineSchedulerOptions = {}
): ScheduledPipeline | null {
  const registry = loadScheduleRegistry(options);
  const schedule = registry.schedules.find((entry) => entry.id === id);
  if (!schedule || !schedule.runLock || schedule.runLock.token !== token) return null;

  schedule.runLock = undefined;
  schedule.lastStatus = status;
  saveScheduleRegistry(registry, options);
  return schedule;
}
