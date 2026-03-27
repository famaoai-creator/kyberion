import {
  logger,
  safeExistsSync,
  safeCopyFileSync,
  safeMkdir,
  listGenerationSchedules,
  registerGenerationSchedule,
  readGenerationSchedule,
  markGenerationScheduleSubmitted,
  markGenerationScheduleReconciled,
  isGenerationScheduleDue,
} from '@agent/core';
import { buildExecutionEnv, withExecutionContext } from '@agent/core/governance';
import { createStandardYargs } from '@agent/core/cli-utils';
import * as path from 'node:path';
import { handleAction as handleMediaGenerationAction } from '../libs/actuators/media-generation-actuator/src/index.js';

function normalizeScheduleId(value: string): string {
  return value.endsWith('.json') ? value.slice(0, -5) : value;
}

async function getLastJobStatus(schedule: any): Promise<string | null> {
  if (!schedule.last_job_id) return null;
  try {
    const job = await handleMediaGenerationAction({
      action: 'get_generation_job',
      params: { job_id: schedule.last_job_id },
    });
    return job?.status || null;
  } catch {
    return null;
  }
}

async function reconcileSchedule(schedule: any): Promise<{ schedule: any; outcome?: any }> {
  if (!schedule.last_job_id) return { schedule };
  const job = await handleMediaGenerationAction({
    action: 'get_generation_job',
    params: { job_id: schedule.last_job_id },
  });

  let aliasUpdated = false;
  const latestAliasPath = schedule.delivery_policy?.latest_alias_path;
  const copiedSource = job?.result?.copied_to || job?.request?.target_path;
  if (job?.status === 'succeeded' && latestAliasPath && copiedSource && safeExistsSync(copiedSource)) {
    safeMkdir(path.dirname(latestAliasPath), { recursive: true });
    safeCopyFileSync(copiedSource, latestAliasPath);
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
    },
  };
}

async function tickSchedule(schedule: any): Promise<any> {
  const reconciliation = await reconcileSchedule(schedule);
  schedule = reconciliation.schedule;
  const dependencies = Array.isArray(schedule.execution_policy?.depends_on) ? schedule.execution_policy.depends_on : [];
  if (dependencies.length > 0) {
    const dependencyStates = dependencies.map((scheduleId: string) => {
      try {
        return readGenerationSchedule(`active/shared/runtime/media-generation/schedules/${normalizeScheduleId(scheduleId)}.json`);
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
  const lastStatus = schedule.last_job_status || await getLastJobStatus(schedule);
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

  const submittedJob = await handleMediaGenerationAction({
    action: 'submit_generation',
    params: {
      action: schedule.job_template.action,
      params: schedule.job_template.params,
      retry_policy: schedule.execution_policy?.retry_policy,
    },
  });

  markGenerationScheduleSubmitted(schedule, submittedJob.job_id);
  return {
    schedule_id: schedule.schedule_id,
    status: 'submitted',
    job_id: submittedJob.job_id,
    provider_prompt_id: submittedJob.provider?.prompt_id || null,
    reconciliation: reconciliation.outcome || null,
  };
}

export async function runGenerationScheduleAction(argv: { action: string; input?: string; schedule?: string }) {
  Object.assign(process.env, buildExecutionEnv(process.env, 'surface_runtime'));

  return withExecutionContext('surface_runtime', async () => {
    switch (argv.action) {
      case 'register': {
        if (!argv.input) throw new Error('register requires --input');
        const logicalPath = path.resolve(process.cwd(), String(argv.input));
        if (!safeExistsSync(logicalPath)) throw new Error(`schedule file not found: ${logicalPath}`);
        return registerGenerationSchedule(logicalPath);
      }
      case 'list':
        return listGenerationSchedules();
      case 'tick': {
        const schedules = argv.schedule
          ? [readGenerationSchedule(`active/shared/runtime/media-generation/schedules/${normalizeScheduleId(String(argv.schedule))}.json`)]
          : listGenerationSchedules();
        const results = [];
        for (const schedule of schedules) {
          results.push(await tickSchedule(schedule));
        }
        return { status: 'completed', results };
      }
      default:
        throw new Error(`Unsupported action: ${argv.action}`);
    }
  });
}

async function main() {
  const argv = await createStandardYargs()
    .option('action', { type: 'string', choices: ['register', 'list', 'tick'], demandOption: true })
    .option('input', { alias: 'i', type: 'string' })
    .option('schedule', { type: 'string' })
    .parseSync();
  const result = await runGenerationScheduleAction({
    action: String(argv.action),
    input: argv.input ? String(argv.input) : undefined,
    schedule: argv.schedule ? String(argv.schedule) : undefined,
  });

  console.log(JSON.stringify(result, null, 2));
}

const isMain = process.argv[1] && (
  process.argv[1].endsWith('scripts/run_generation_schedule.ts') ||
  process.argv[1].endsWith('dist/scripts/run_generation_schedule.js')
);

if (isMain) {
  main().catch((err) => {
    logger.error(err.message);
    process.exit(1);
  });
}
