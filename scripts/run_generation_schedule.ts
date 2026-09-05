import * as path from 'node:path';
import { assertSafeRepositoryPath, safeExistsSync } from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';
import {
  registerGenerationSchedule,
  runGenerationScheduleAction as runGovernedGenerationScheduleAction,
  GENERATION_SCHEDULER_AUTHORITY,
} from '@agent/core/generation-scheduler';
import { normalizeEventScope, type EventScopeInput } from '@agent/core/event-scope';
import { assertProtocolServiceRegistered } from '@agent/core/protocol-service-registry';
import { recordProtocolServiceLifecycleBestEffort } from '@agent/core/protocol-service-lifecycle';
import { buildExecutionEnv, withExecutionContext } from '@agent/core/governance';
import { createStandardYargs } from '@agent/core/cli-utils';
import { defineScript, isDirectScript, stripSharedScriptFlags } from './lib/harness.js';

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
  assertProtocolServiceRegistered('generation-scheduler');
  const lifecycleScope = argv.scope || { scope_kind: 'system' as const, tier: 'public' as const };
  const recordHealthy = () =>
    recordProtocolServiceLifecycleBestEffort({
      serviceId: 'generation-scheduler',
      action: 'health_check',
      status: 'healthy',
      scope: lifecycleScope,
      actorRole: 'infrastructure_sentinel',
      principal: { kind: 'service', id: 'generation-scheduler' },
      requestedBy: 'generation-scheduler',
      metadata: { action: argv.action },
    });
  switch (argv.action) {
    case 'register': {
      if (!argv.input) throw new Error('register requires --input');
      Object.assign(process.env, buildExecutionEnv(process.env, 'surface_runtime'));
      return withExecutionContext('surface_runtime', () => {
        const inputPath = String(argv.input);
        const logicalPath = assertSafeRepositoryPath(
          path.isAbsolute(inputPath) ? inputPath : pathResolver.resolve(inputPath)
        );
        if (!safeExistsSync(logicalPath))
          throw new Error(`schedule file not found: ${logicalPath}`);
        const result = registerGenerationSchedule(logicalPath);
        recordHealthy();
        return result;
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
      const result = await runGovernedGenerationScheduleAction({
        action: argv.action,
        ...(argv.schedule ? { schedule: argv.schedule } : {}),
        ...(argv.scope ? { scope: argv.scope } : {}),
      });
      recordHealthy();
      return result;
    }
    default:
      throw new Error(`Unsupported action: ${argv.action}`);
  }
}

export async function main(args: string[] = [], print: (value: unknown) => void = () => undefined) {
  const argv = await createStandardYargs(['node', 'run_generation_schedule', ...args])
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

  print(result);
}

if (
  isDirectScript(import.meta.url, 'run_generation_schedule.ts') ||
  isDirectScript(import.meta.url, 'run_generation_schedule.js')
)
  void defineScript({
    name: 'generation-schedule',
    flags: ['json', 'quiet'],
    run({ argv, print }) {
      return main(stripSharedScriptFlags(argv), print);
    },
  })();
