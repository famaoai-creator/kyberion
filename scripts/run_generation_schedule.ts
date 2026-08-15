import {
  logger,
  safeExistsSync,
  registerGenerationSchedule,
  runGenerationScheduleAction as runGovernedGenerationScheduleAction,
  GENERATION_SCHEDULER_AUTHORITY,
  normalizeEventScope,
  type EventScopeInput,
} from '@agent/core';
import { buildExecutionEnv, withExecutionContext } from '@agent/core/governance';
import { createStandardYargs } from '@agent/core/cli-utils';
import { resolveCliInputPath } from './refactor/cli-input.js';

/**
 * EV-01: this script used to carry a full second copy of the tick logic
 * (reconcile → dependency check → due check → submit), and since the daemon
 * invokes `dist/scripts/run_generation_schedule.js --action tick`, that copy —
 * not the one in libs/core — was the code that actually fired. The two drifted:
 * the library gained the trigger gate, the script kept firing ungoverned.
 *
 * The CLI now owns only argument handling and `register`; `list`/`tick`
 * delegate to the single governed implementation in
 * `libs/core/generation-scheduler.ts`, which holds the leader lease, the
 * TriggerRunner idempotency gate, and the `generation_scheduler` authority.
 */
export async function runGenerationScheduleAction(argv: {
  action: string;
  input?: string;
  schedule?: string;
  scope?: EventScopeInput;
}) {
  switch (argv.action) {
    case 'register': {
      if (!argv.input) throw new Error('register requires --input');
      Object.assign(process.env, buildExecutionEnv(process.env, 'surface_runtime'));
      return withExecutionContext('surface_runtime', () => {
        const logicalPath = resolveCliInputPath(String(argv.input));
        if (!safeExistsSync(logicalPath))
          throw new Error(`schedule file not found: ${logicalPath}`);
        return registerGenerationSchedule(logicalPath);
      });
    }
    case 'list':
    case 'tick': {
      // The library re-enters its own execution context; seeding the env here
      // keeps a child process spawned mid-tick on the same authority.
      Object.assign(
        process.env,
        buildExecutionEnv(process.env, GENERATION_SCHEDULER_AUTHORITY.authority_role)
      );
      return runGovernedGenerationScheduleAction({
        action: argv.action,
        ...(argv.schedule ? { schedule: argv.schedule } : {}),
        ...(argv.scope ? { scope: argv.scope } : {}),
      });
    }
    default:
      throw new Error(`Unsupported action: ${argv.action}`);
  }
}

async function main() {
  const argv = await createStandardYargs()
    .option('action', { type: 'string', choices: ['register', 'list', 'tick'], demandOption: true })
    .option('input', { alias: 'i', type: 'string' })
    .option('schedule', { type: 'string' })
    .option('scope-kind', { type: 'string' })
    .option('tier', { type: 'string' })
    .option('tenant-slug', { type: 'string' })
    .option('organization-id', { type: 'string' })
    .option('project-id', { type: 'string' })
    .option('mission-id', { type: 'string' })
    .option('task-id', { type: 'string' })
    .option('session-id', { type: 'string' })
    .parseSync();
  const scopeValues: EventScopeInput = {
    ...(argv.scopeKind
      ? { scope_kind: String(argv.scopeKind) as EventScopeInput['scope_kind'] }
      : {}),
    ...(argv.tier ? { tier: String(argv.tier) as EventScopeInput['tier'] } : {}),
    ...(argv.tenantSlug ? { tenant_slug: String(argv.tenantSlug) } : {}),
    ...(argv.organizationId ? { organization_id: String(argv.organizationId) } : {}),
    ...(argv.projectId ? { project_id: String(argv.projectId) } : {}),
    ...(argv.missionId ? { mission_id: String(argv.missionId) } : {}),
    ...(argv.taskId ? { task_id: String(argv.taskId) } : {}),
    ...(argv.sessionId ? { session_id: String(argv.sessionId) } : {}),
  };
  const scope = Object.keys(scopeValues).length > 0 ? normalizeEventScope(scopeValues) : undefined;
  const result = await runGenerationScheduleAction({
    action: String(argv.action),
    input: argv.input ? String(argv.input) : undefined,
    schedule: argv.schedule ? String(argv.schedule) : undefined,
    ...(scope ? { scope } : {}),
  });

  console.log(JSON.stringify(result, null, 2));
}

const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith('scripts/run_generation_schedule.ts') ||
    process.argv[1].endsWith('dist/scripts/run_generation_schedule.js'));

if (isMain) {
  main().catch((err) => {
    logger.error(err.message);
    process.exit(1);
  });
}
