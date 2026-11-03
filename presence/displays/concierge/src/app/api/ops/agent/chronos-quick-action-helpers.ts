import path from 'node:path';
import { nowIso } from '@agent/core/foundation';
import type { MissionState } from '@agent/core/mission/mission-types';
import { uxMessage, type SupportedLocale } from '../../../../lib/ops/ux-vocabulary';
import { recordField } from '../../../../lib/ops/json-record';

type ChronosQuickActionCore = {
  pathResolver: {
    active(relativePath: string): string;
  };
  assertSafeRepositoryPath(filePath: string, options?: { allowMissingLeaf?: boolean }): string;
  safeExistsSync(filePath: string): boolean;
  safeLstat(filePath: string): { isDirectory(): boolean; isFile(): boolean };
  safeReaddir(directoryPath: string): string[];
  loadStateAtPath(filePath: string): MissionState | null;
  loadMissionNextTaskRecordsAtPath(
    filePath: string,
    expectedMissionId: string
  ): Array<{ task_id?: string; status?: string }> | null;
  safeExecResult(
    command: string,
    args: string[],
    options: { cwd: string; maxOutputMB: number }
  ): { status?: number | null; stdout?: unknown; stderr?: unknown };
};

export type ActiveMissionProjection = {
  missionId: string;
  status: string;
  tier: string;
  missionType?: string;
  checkpoints: number;
  nextTaskCount: number;
  planReady: boolean;
};

export function collectActiveMissions(core: ChronosQuickActionCore): ActiveMissionProjection[] {
  const roots = [
    { dir: core.pathResolver.active('missions/public'), tier: 'public' },
    { dir: core.pathResolver.active('missions/confidential'), tier: 'confidential' },
  ];
  const missions: ActiveMissionProjection[] = [];

  for (const root of roots) {
    let safeRoot: string;
    try {
      safeRoot = core.assertSafeRepositoryPath(root.dir, { allowMissingLeaf: true });
      if (!core.safeExistsSync(safeRoot) || !core.safeLstat(safeRoot).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const item of core.safeReaddir(safeRoot)) {
      const missionDir = path.join(safeRoot, item);
      try {
        const safeMissionDir = core.assertSafeRepositoryPath(missionDir, {
          allowMissingLeaf: true,
        });
        if (!core.safeExistsSync(safeMissionDir) || !core.safeLstat(safeMissionDir).isDirectory()) {
          continue;
        }
        const statePath = core.assertSafeRepositoryPath(
          path.join(safeMissionDir, 'mission-state.json')
        );
        if (!core.safeExistsSync(statePath) || !core.safeLstat(statePath).isFile()) continue;
        const state = core.loadStateAtPath(statePath);
        const status = state?.status;
        if (!status || !['active', 'planned', 'paused', 'failed'].includes(status)) continue;
        let nextTaskCount = 0;
        try {
          const nextTasksPath = core.assertSafeRepositoryPath(
            path.join(safeMissionDir, 'NEXT_TASKS.json')
          );
          if (core.safeExistsSync(nextTasksPath) && core.safeLstat(nextTasksPath).isFile()) {
            nextTaskCount = core.loadMissionNextTaskRecordsAtPath(nextTasksPath, item)?.length || 0;
          }
        } catch {
          // Optional task projection is omitted when its path is unsafe.
        }
        let planReady = false;
        try {
          const planPath = core.assertSafeRepositoryPath(path.join(safeMissionDir, 'PLAN.md'));
          planReady = core.safeExistsSync(planPath) && core.safeLstat(planPath).isFile();
        } catch {
          // Optional plan projection is omitted when its path is unsafe.
        }
        const git = recordField(state.git);
        missions.push({
          missionId: state.mission_id || item,
          status,
          tier: state.tier || root.tier,
          missionType: state.mission_type,
          checkpoints: Array.isArray(git.checkpoints) ? git.checkpoints.length : 0,
          nextTaskCount,
          planReady,
        });
      } catch {
        // Ignore a single malformed or replaced mission entry.
      }
    }
  }

  return missions.sort((a, b) => a.missionId.localeCompare(b.missionId));
}

export function runCommandQuickAction(
  core: ChronosQuickActionCore,
  projectRoot: string,
  title: string,
  command: string[],
  description: string,
  locale: SupportedLocale
) {
  const result = core.safeExecResult('pnpm', command, {
    cwd: projectRoot,
    maxOutputMB: 4,
  });
  const output = [result.stdout, result.stderr]
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join('\n');
  const ok = result.status === 0;
  return {
    status: ok ? 'ok' : 'warning',
    response: uxMessage(
      ok ? 'chronos_command_completed' : 'chronos_command_completed_with_warnings',
      { title },
      `${title} completed${ok ? '' : ' with warnings'}.`,
      locale
    ),
    a2ui: [
      {
        type: 'display:hero',
        props: {
          eyebrow: 'Readiness',
          title,
          description,
          status: ok ? 'ready' : 'attention',
        },
      },
      {
        type: 'display:metrics-row',
        props: {
          metrics: [
            { label: 'exit', value: result.status ?? -1, trend: ok ? 'flat' : 'down' },
            { label: 'stdout', value: output ? output.split('\n').length : 0, trend: 'flat' },
            { label: 'status', value: ok ? 'ok' : 'warning', trend: ok ? 'flat' : 'down' },
          ],
        },
      },
      {
        type: 'display:log',
        props: {
          title: `${title} Output`,
          lines: output ? output.split('\n').slice(-30) : ['(no output)'],
        },
      },
    ],
    timestamp: nowIso(),
  };
}

/** The governed schedule worker and the system role it already runs under. */
export const GENERATION_SCHEDULE_WORKER_SCRIPT = 'dist/scripts/run_generation_schedule.js';
export const GENERATION_SCHEDULE_WORKER_ROLE = 'generation_schedule';
const GENERATION_SCHEDULE_WORKER_TIMEOUT_MS = 120_000;

type ScheduleWorkerResult = {
  stdout: string;
  stderr: string;
  status: number | null;
  error?: Error;
};
type ScheduleWorkerAudit = { action: string; result: 'completed' | 'failed'; reason?: string };

export interface ScheduleWorkerDeps {
  run?: (
    command: string,
    args: string[],
    options: { cwd: string; env: Record<string, string | undefined>; timeoutMs: number }
  ) => Promise<ScheduleWorkerResult>;
  audit?: (entry: ScheduleWorkerAudit) => void;
}

/**
 * D3: the schedule tick needs the generation_scheduler authority (and the
 * media actuators it loads need reconcile_config_fallbacks), which the
 * Concierge process must never assume. The quick action is dispatched to the
 * governed CLI (scripts/run_generation_schedule.ts) as a child under
 * SYSTEM_ROLE=generation_schedule — the role the scheduler daemon already
 * runs as, whose policy grants exactly generation_scheduler — and every
 * dispatch is audited.
 */
export async function dispatchGenerationScheduleWorker(
  action: 'list' | 'tick',
  deps: ScheduleWorkerDeps = {}
): Promise<unknown> {
  const [secureIo, authority, paths, audit] = await Promise.all([
    import('@agent/core/secure-io'),
    import('@agent/core/authority'),
    import('@agent/core/path-resolver'),
    import('@agent/core/governance/audit-chain'),
  ]);
  const run = deps.run ?? secureIo.safeExecResultAsync;
  const record =
    deps.audit ??
    ((entry: ScheduleWorkerAudit) =>
      audit.auditChain.record({
        agentId: 'concierge-ops-console',
        action: 'governed_worker_dispatch',
        operation: `generation_schedule:${entry.action}`,
        result: entry.result,
        ...(entry.reason ? { reason: entry.reason } : {}),
        metadata: {
          worker: GENERATION_SCHEDULE_WORKER_SCRIPT,
          system_role: GENERATION_SCHEDULE_WORKER_ROLE,
        },
      }));
  const env = authority.buildSystemRoleLaunchEnv({}, GENERATION_SCHEDULE_WORKER_ROLE, {
    persona: 'worker',
  }) as Record<string, string | undefined>;
  const result = await run(
    'node',
    [GENERATION_SCHEDULE_WORKER_SCRIPT, '--action', action, '--json'],
    {
      cwd: paths.pathResolver.rootDir(),
      env,
      timeoutMs: GENERATION_SCHEDULE_WORKER_TIMEOUT_MS,
    }
  );
  if (result.status !== 0) {
    const reason = (result.stderr || result.error?.message || 'schedule worker failed').trim();
    record({ action, result: 'failed', reason: reason.split('\n').slice(-1)[0] });
    throw new Error(reason);
  }
  record({ action, result: 'completed' });
  const output = result.stdout.trim();
  try {
    return JSON.parse(output);
  } catch {
    return output;
  }
}

export async function runScheduleQuickAction(
  action: 'list' | 'tick',
  locale: SupportedLocale,
  deps: ScheduleWorkerDeps = {}
) {
  try {
    const result = await dispatchGenerationScheduleWorker(action, deps);
    const serialized = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    return {
      status: 'ok',
      response: uxMessage(
        'chronos_schedule_completed',
        { action },
        `Schedule ${action} completed.`,
        locale
      ),
      a2ui: [
        {
          type: 'display:hero',
          props: {
            eyebrow: 'Schedule',
            title: action === 'tick' ? 'Schedule Tick' : 'Schedule List',
            description:
              action === 'tick'
                ? 'Tick due generation schedules and submit any ready jobs.'
                : 'Inspect the current generation schedule registry.',
            status: action === 'tick' ? 'ticked' : 'listed',
          },
        },
        {
          type: 'display:log',
          props: {
            title: action === 'tick' ? 'Tick Result' : 'Schedule Registry',
            lines: serialized.split('\n'),
          },
        },
      ],
      timestamp: nowIso(),
    };
  } catch (err: any) {
    const message = String(err?.message || err || 'schedule action failed');
    return {
      status: 'warning',
      response: uxMessage(
        'chronos_schedule_failed',
        { action },
        `Schedule ${action} failed.`,
        locale
      ),
      a2ui: [
        {
          type: 'display:hero',
          props: {
            eyebrow: 'Schedule',
            title: action === 'tick' ? 'Schedule Tick' : 'Schedule List',
            description: 'The schedule registry is reachable, but the action returned an error.',
            status: 'attention',
          },
        },
        {
          type: 'display:log',
          props: {
            title: 'Schedule Error',
            lines: message.split('\n').slice(-20),
          },
        },
      ],
      timestamp: nowIso(),
    };
  }
}
