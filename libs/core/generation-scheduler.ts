import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { safeCopyFileSync, safeExistsSync, safeMkdir, safeReadFile, safeReaddir, safeWriteFile } from './secure-io.js';
import type { GenerationSchedule } from './src/types/generation-schedule.js';
import { matchesCron, getZonedDateParts } from './src/cron-utils.js';
import { pathResolver } from './path-resolver.js';

export const GENERATION_SCHEDULE_DIR = 'active/shared/runtime/media-generation/schedules';

function nowIso(date = new Date()): string {
  return date.toISOString();
}

function ensureScheduleDir(): void {
  if (!safeExistsSync(GENERATION_SCHEDULE_DIR)) {
    safeMkdir(GENERATION_SCHEDULE_DIR, { recursive: true });
  }
}

export function generationSchedulePath(scheduleId: string): string {
  return path.join(GENERATION_SCHEDULE_DIR, `${scheduleId}.json`);
}

function resolveRootRelativePath(logicalPath?: string): string | null {
  if (!logicalPath) return null;
  return pathResolver.rootResolve(logicalPath);
}

export function resolveGenerationScheduleDeliveryPaths(schedule: GenerationSchedule): {
  artifactDir: string | null;
  latestAliasPath: string | null;
  schedulePath: string;
} {
  return {
    artifactDir: resolveRootRelativePath(schedule.delivery_policy?.artifact_dir || null),
    latestAliasPath: resolveRootRelativePath(schedule.delivery_policy?.latest_alias_path || null),
    schedulePath: generationSchedulePath(schedule.schedule_id),
  };
}

export function resolveGenerationScheduleWorkdir(schedule: GenerationSchedule): string {
  const artifactDir = resolveRootRelativePath(schedule.delivery_policy?.artifact_dir || '');
  if (artifactDir) return artifactDir;

  const latestAliasPath = resolveRootRelativePath(schedule.delivery_policy?.latest_alias_path || '');
  if (latestAliasPath) return path.dirname(latestAliasPath);

  return pathResolver.rootResolve(path.dirname(generationSchedulePath(schedule.schedule_id)));
}

export function readGenerationSchedule(logicalPath: string): GenerationSchedule {
  return JSON.parse(safeReadFile(logicalPath, { encoding: 'utf8' }) as string) as GenerationSchedule;
}

export function writeGenerationSchedule(schedule: GenerationSchedule): GenerationSchedule {
  ensureScheduleDir();
  safeWriteFile(generationSchedulePath(schedule.schedule_id), JSON.stringify(schedule, null, 2));
  return schedule;
}

export function registerGenerationSchedule(sourcePath: string): GenerationSchedule {
  const schedule = readGenerationSchedule(sourcePath);
  return writeGenerationSchedule({
    ...schedule,
    updated_at: nowIso(),
  });
}

export function listGenerationSchedules(): GenerationSchedule[] {
  if (!safeExistsSync(GENERATION_SCHEDULE_DIR)) return [];
  return safeReaddir(GENERATION_SCHEDULE_DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => readGenerationSchedule(path.join(GENERATION_SCHEDULE_DIR, name)))
    .sort((a, b) => a.schedule_id.localeCompare(b.schedule_id));
}

export function isGenerationScheduleDue(schedule: GenerationSchedule, now = new Date()): boolean {
  if (!schedule.enabled) return false;
  const lastRunAt = (schedule as any).last_submitted_at || schedule.created_at;
  const lastRun = lastRunAt ? new Date(lastRunAt) : null;

  if (schedule.trigger.type === 'interval') {
    const intervalMs = Number(schedule.trigger.interval_ms || 0);
    if (!intervalMs) return false;
    if (!lastRun) return true;
    return now.getTime() - lastRun.getTime() >= intervalMs;
  }

  if (schedule.trigger.type === 'cron') {
    const cronExpr = String(schedule.trigger.cron || '');
    if (!matchesCron(cronExpr, now, schedule.trigger.timezone)) return false;
    if (!lastRun) return true;
    // Avoid re-triggering within the same minute
    const lastRunParts = getZonedDateParts(lastRun, schedule.trigger.timezone);
    const nowParts = getZonedDateParts(now, schedule.trigger.timezone);
    return (
      lastRunParts.year !== nowParts.year ||
      lastRunParts.month !== nowParts.month ||
      lastRunParts.day !== nowParts.day ||
      lastRunParts.hour !== nowParts.hour ||
      lastRunParts.minute !== nowParts.minute
    );
  }

  return false;
}

export function markGenerationScheduleSubmitted(
  schedule: GenerationSchedule,
  jobId: string,
  submittedAt = nowIso(),
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
  updatedAt = nowIso(),
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

async function loadMediaGenerationActuator() {
  return import(
    /* webpackIgnore: true */
    pathToFileURL(pathResolver.rootResolve('libs/actuators/media-generation-actuator/src/index.js')).href
  );
}

async function getLastGenerationJobStatus(
  schedule: GenerationSchedule,
): Promise<string | null> {
  if (!schedule.last_job_id) return null;
  try {
    const { handleAction } = await loadMediaGenerationActuator();
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
): Promise<{ schedule: GenerationSchedule; outcome?: Record<string, unknown> }> {
  if (!schedule.last_job_id) return { schedule };

  const { handleAction } = await loadMediaGenerationActuator();
  const job = await handleAction({
    action: 'get_generation_job',
    params: { job_id: schedule.last_job_id },
  });

  let aliasUpdated = false;
  const { artifactDir, latestAliasPath } = resolveGenerationScheduleDeliveryPaths(schedule);
  const workdir = resolveGenerationScheduleWorkdir(schedule);
  const copiedSource = job?.result?.copied_to || job?.request?.target_path;
  if (job?.status === 'succeeded' && latestAliasPath && copiedSource && safeExistsSync(copiedSource)) {
    safeMkdir(path.dirname(latestAliasPath), { recursive: true });
    safeCopyFileSync(path.resolve(copiedSource), latestAliasPath);
    aliasUpdated = true;
  }

  const updatedSchedule = markGenerationScheduleReconciled(schedule, {
    last_job_status: job?.status || schedule.last_job_status || null,
    last_completed_at: job?.completed_at || schedule.last_completed_at,
  });

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
    },
  };
}

async function tickGenerationSchedule(
  schedule: GenerationSchedule,
): Promise<Record<string, unknown>> {
  const reconciliation = await reconcileGenerationSchedule(schedule);
  schedule = reconciliation.schedule;

  const dependencies = Array.isArray(schedule.execution_policy?.depends_on)
    ? schedule.execution_policy.depends_on
    : [];
  if (dependencies.length > 0) {
    const dependencyStates = dependencies.map((scheduleId) => {
      try {
        return readGenerationSchedule(
          `active/shared/runtime/media-generation/schedules/${normalizeGenerationScheduleId(scheduleId)}.json`,
        );
      } catch {
        return null;
      }
    });
    const unresolved = dependencyStates.filter((dep) => !dep || dep.last_job_status !== 'succeeded');
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

  const lastStatus = schedule.last_job_status || await getLastGenerationJobStatus(schedule);
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

  if (!isGenerationScheduleDue(schedule, new Date())) {
    return {
      schedule_id: schedule.schedule_id,
      status: 'skipped',
      reason: 'schedule is not due',
      last_job_id: schedule.last_job_id || null,
      reconciliation: reconciliation.outcome || null,
    };
  }

  const { handleAction } = await loadMediaGenerationActuator();
  const submittedJob = await handleAction({
    action: 'submit_generation',
    params: {
      action: schedule.job_template.action,
      params: schedule.job_template.params,
      retry_policy: schedule.execution_policy?.retry_policy,
    },
  });

  if (!submittedJob?.job_id) {
    return {
      schedule_id: schedule.schedule_id,
      status: 'failed',
      reason: 'job submission did not return a job_id',
      reconciliation: reconciliation.outcome || null,
    };
  }

  markGenerationScheduleSubmitted(schedule, submittedJob.job_id);
  return {
    schedule_id: schedule.schedule_id,
    status: 'submitted',
    job_id: submittedJob.job_id,
    provider_prompt_id: submittedJob.provider?.prompt_id || null,
    reconciliation: reconciliation.outcome || null,
  };
}

export async function runGenerationScheduleAction(argv: {
  action: GenerationScheduleAction;
  schedule?: string;
}): Promise<GenerationSchedule[] | { status: 'completed'; results: Record<string, unknown>[] }> {
  switch (argv.action) {
    case 'list':
      return listGenerationSchedules();
    case 'tick': {
      const schedules = argv.schedule
        ? [readGenerationSchedule(
            `active/shared/runtime/media-generation/schedules/${normalizeGenerationScheduleId(String(argv.schedule))}.json`,
          )]
        : listGenerationSchedules();
      const results: Record<string, unknown>[] = [];
      for (const schedule of schedules) {
        results.push(await tickGenerationSchedule(schedule));
      }
      return { status: 'completed', results };
    }
    default:
      throw new Error(`Unsupported action: ${String(argv.action)}`);
  }
}
