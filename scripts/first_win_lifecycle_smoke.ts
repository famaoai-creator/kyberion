#!/usr/bin/env node
import {
  extractHintsFromTrace,
  loadOrganizationOperationalState,
  loadProjectRecord,
  matchesCron,
  pathResolver,
  safeExecResult,
  safeExistsSync,
  safeReadFile,
} from '@agent/core';
import { loadState } from '@agent/core/mission-state';
import type { Trace, TraceSpan } from '@agent/core';

export const FIRST_WIN_LIFECYCLE_STAGES = [
  'onboard',
  'organization',
  'project',
  'mission',
  'schedule',
  'hints',
] as const;
export type FirstWinLifecycleStage = (typeof FIRST_WIN_LIFECYCLE_STAGES)[number];

export interface FirstWinLifecycleStageResult {
  stage: FirstWinLifecycleStage;
  status: 'passed' | 'failed';
  detail: string;
}

export interface FirstWinLifecycleReport {
  mode: 'dry-run' | 'live';
  status: 'passed' | 'failed';
  run_id?: string;
  stages: FirstWinLifecycleStageResult[];
}

interface StageObservation extends FirstWinLifecycleStageResult {
  stdout: string;
  stderr: string;
}

const IDENTITY_FIXTURE = 'knowledge/public/templates/onboarding/identity.example.json';
const ORGANIZATION_ID = 'ORG-FIRST-WIN-SMOKE';
const PROJECT_ID = 'PRJ-FIRST-WIN-SMOKE';
const MISSION_ID = 'MSN-FIRST-WIN-SMOKE';
const PROJECT_PATH = 'active/shared/tmp/first-win-lifecycle';
const LIFECYCLE_PIPELINE = 'pipelines/first-win-lifecycle-weekly.json';
const LIVE_CONFIRMATION = 'FIRST-WIN-LIFECYCLE-LIVE';

export interface FirstWinLifecycleLiveOptions {
  identityFile: string;
  runId: string;
  confirm: string;
  allowWrites: string | undefined;
}

export interface FirstWinLifecycleLivePlan {
  runId: string;
  organizationId: string;
  projectId: string;
  missionId: string;
  projectPath: string;
  identityFile: string;
}

export interface FirstWinLifecycleLiveReaders {
  organization: typeof loadOrganizationOperationalState;
  project: typeof loadProjectRecord;
  mission: typeof loadState;
  missionState: typeof loadState;
  projectPath: (path: string) => boolean;
  archiveMission: (missionId: string) => boolean;
}

const DEFAULT_LIVE_READERS: FirstWinLifecycleLiveReaders = {
  organization: loadOrganizationOperationalState,
  project: loadProjectRecord,
  mission: loadState,
  missionState: loadState,
  projectPath: (projectPath) => safeExistsSync(pathResolver.rootResolve(projectPath)),
  archiveMission: (missionId) =>
    safeExistsSync(pathResolver.rootResolve(`active/archive/missions/${missionId}`)),
};

function resolveLiveReaders(
  readers: Partial<FirstWinLifecycleLiveReaders> = {}
): FirstWinLifecycleLiveReaders {
  return { ...DEFAULT_LIVE_READERS, ...readers };
}

export function validateFirstWinLifecycleLiveOptions(
  options: FirstWinLifecycleLiveOptions
): string[] {
  const violations: string[] = [];
  if (!options.identityFile.trim()) {
    violations.push('--identity is required for live acceptance; the fixture is dry-run only');
  } else if (!safeExistsSync(pathResolver.rootResolve(options.identityFile))) {
    violations.push(`--identity file not found: ${options.identityFile}`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/u.test(options.runId)) {
    violations.push("--run-id must contain 3-64 letters, numbers, '.', '_' or '-'");
  }
  if (options.confirm !== LIVE_CONFIRMATION) {
    violations.push(`--confirm-live must equal ${LIVE_CONFIRMATION}`);
  }
  if (options.allowWrites !== '1') {
    violations.push('KYBERION_FIRST_WIN_LIVE=1 is required for live acceptance');
  }
  return violations;
}

export function buildFirstWinLifecycleLivePlan(input: {
  identityFile: string;
  runId: string;
}): FirstWinLifecycleLivePlan {
  const suffix = input.runId.toUpperCase();
  return {
    runId: input.runId,
    identityFile: input.identityFile,
    organizationId: `ORG-FIRST-WIN-${suffix}`,
    projectId: `PRJ-FIRST-WIN-${suffix}`,
    missionId: `MSN-FIRST-WIN-${suffix}`,
    projectPath: `${PROJECT_PATH}/${input.runId}`,
  };
}

export function findFirstWinLifecycleLiveConflicts(
  plan: FirstWinLifecycleLivePlan,
  readers: Partial<FirstWinLifecycleLiveReaders> = {}
): string[] {
  const resolved = resolveLiveReaders(readers);
  const conflicts: string[] = [];
  if (resolved.organization(plan.organizationId, { tier: 'personal' })) {
    conflicts.push(`organization ${plan.organizationId} already exists`);
  }
  if (resolved.project(plan.projectId)) {
    conflicts.push(`project ${plan.projectId} already exists`);
  }
  if (resolved.mission(plan.missionId) || resolved.archiveMission(plan.missionId)) {
    conflicts.push(`mission ${plan.missionId} already exists`);
  }
  if (resolved.projectPath(plan.projectPath)) {
    conflicts.push(`project path ${plan.projectPath} already exists`);
  }
  return conflicts;
}

function parseJsonPayload(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    // Some governed CLIs write logger lines around machine-readable output.
    // Recover a complete top-level object without accepting arbitrary text.
    let start = -1;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = 0; index < raw.length; index += 1) {
      const character = raw[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') {
        inString = true;
        continue;
      }
      if (character === '{') {
        if (depth === 0) start = index;
        depth += 1;
      } else if (character === '}' && depth > 0) {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          try {
            const parsed = JSON.parse(raw.slice(start, index + 1));
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              return parsed as Record<string, unknown>;
            }
          } catch {
            start = -1;
          }
        }
      }
    }
  }
  return null;
}

function observation(
  stage: FirstWinLifecycleStage,
  status: 'passed' | 'failed',
  detail: string,
  stdout = '',
  stderr = ''
): StageObservation {
  return { stage, status, detail, stdout, stderr };
}

function runCommand(
  stage: FirstWinLifecycleStage,
  command: string,
  args: string[],
  validate: (payload: Record<string, unknown> | null, raw: string) => boolean,
  runner: typeof safeExecResult = safeExecResult,
  successDetail = 'validated machine-readable dry-run contract'
): StageObservation {
  const result = runner(command, args, {
    cwd: process.cwd(),
    env: { KYBERION_PERSONA: 'sovereign', MISSION_ROLE: 'mission_controller' },
    timeoutMs: 120_000,
  });
  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  if (result.status !== 0) {
    return observation(
      stage,
      'failed',
      `${command} ${args.join(' ')} failed (${result.status}): ${stderr || stdout}`,
      stdout,
      stderr
    );
  }
  const payload = parseJsonPayload(stdout);
  if (!validate(payload, stdout)) {
    return observation(
      stage,
      'failed',
      `${command} returned an unexpected machine-readable contract: ${stdout.trim().slice(-500)}`,
      stdout,
      stderr
    );
  }
  return observation(stage, 'passed', successDetail, stdout, stderr);
}

function runLiveCommand(
  stage: FirstWinLifecycleStage,
  command: string,
  args: string[],
  validate: (payload: Record<string, unknown> | null, raw: string) => boolean,
  runner: typeof safeExecResult,
  successDetail = 'validated live command contract'
): StageObservation {
  try {
    return runCommand(stage, command, args, validate, runner, successDetail);
  } catch (error) {
    return observation(
      stage,
      'failed',
      `${command} ${args.join(' ')} raised an exception: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function missionSuccessPattern(action: string, missionId: string): RegExp {
  const escapedId = missionId.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const patterns: Record<string, string> = {
    create: `Mission ${escapedId} initialized in `,
    start: `Mission ${escapedId} is now ACTIVE`,
    verify: `Mission ${escapedId} verification complete`,
    distill: `Wisdom distilled for ${escapedId}`,
    finish: `Mission ${escapedId} archived and finalized`,
  };
  return new RegExp(patterns[action] || `Mission ${escapedId}`, 'u');
}

function validateMissionLiveOutput(action: string, missionId: string, raw: string): boolean {
  if (!missionSuccessPattern(action, missionId).test(raw)) return false;
  return !/\b(error|failed|blocked|cannot|already exists|not found|usage)\b/i.test(raw);
}

function runScheduleStage(): StageObservation {
  const pipeline = JSON.parse(
    String(safeReadFile(pathResolver.rootResolve(LIFECYCLE_PIPELINE), { encoding: 'utf8' }))
  ) as { schedule?: { cron?: string; timezone?: string; enabled?: boolean } };
  const schedule = pipeline.schedule;
  const cron = schedule?.cron || '';
  const timezone = schedule?.timezone || '';
  const scheduledTick = new Date('2026-08-10T00:00:00.000Z'); // 09:00 Asia/Tokyo
  const wrongZoneTick = new Date('2026-08-10T09:00:00.000Z'); // 18:00 Asia/Tokyo
  const matched =
    schedule?.enabled === true &&
    Boolean(cron) &&
    Boolean(timezone) &&
    matchesCron(cron, scheduledTick, timezone) &&
    !matchesCron(cron, wrongZoneTick, timezone);
  return matched
    ? observation('schedule', 'passed', `matched ${cron} in ${timezone}`)
    : observation('schedule', 'failed', `schedule contract did not match ${cron} in ${timezone}`);
}

function buildLifecycleTrace(stages: StageObservation[]): Trace {
  const children: TraceSpan[] = stages.map((stage, index) => ({
    spanId: `first-win-${stage.stage}-${index}`,
    name: `first-win:${stage.stage}`,
    startTime: '2026-08-10T00:00:00.000Z',
    endTime: '2026-08-10T00:00:01.000Z',
    status: stage.status === 'failed' ? 'error' : 'ok',
    ...(stage.status === 'failed' ? { error: stage.detail } : {}),
    events: [
      {
        name: 'command-result',
        timestamp: '2026-08-10T00:00:01.000Z',
        attributes: { status: stage.status, output_bytes: stage.stdout.length },
      },
    ],
    artifacts: [],
    knowledgeRefs: [LIFECYCLE_PIPELINE],
    children: [],
  }));
  return {
    traceId: 'first-win-lifecycle-smoke',
    metadata: {
      actuator: 'system',
      pipelineId: 'first-win-lifecycle-weekly',
      startedAt: '2026-08-10T00:00:00.000Z',
      completedAt: '2026-08-10T00:00:01.000Z',
    },
    rootSpan: {
      spanId: 'first-win-root',
      name: 'first-win-lifecycle',
      startTime: '2026-08-10T00:00:00.000Z',
      endTime: '2026-08-10T00:00:01.000Z',
      status: stages.some((stage) => stage.status === 'failed') ? 'error' : 'ok',
      events: [],
      artifacts: [],
      knowledgeRefs: [LIFECYCLE_PIPELINE],
      children,
    },
  };
}

function runHintsStage(stages: StageObservation[]): StageObservation {
  const trace = buildLifecycleTrace(stages);
  const hints = extractHintsFromTrace(trace);
  const failedStages = stages.filter((stage) => stage.status === 'failed');
  if (failedStages.length === 0) {
    return observation(
      'hints',
      'passed',
      'real lifecycle trace contained no failures; no failure hint was required'
    );
  }
  return hints.length > 0
    ? observation('hints', 'failed', `generated ${hints.length} hint(s) from real failed stages`)
    : observation('hints', 'failed', 'real failed stages produced no meaningful hint');
}

export function runFirstWinLifecycleDryRun(): FirstWinLifecycleReport {
  const identity = JSON.parse(
    String(safeReadFile(pathResolver.rootResolve(IDENTITY_FIXTURE), { encoding: 'utf8' }))
  ) as { identity?: { agent_id?: string } };
  const expectedAgentId = identity.identity?.agent_id || '';
  const stages: StageObservation[] = [
    runCommand(
      'onboard',
      'node',
      ['dist/scripts/onboarding_apply.js', '--identity', IDENTITY_FIXTURE, '--dry-run', '--json'],
      (payload) =>
        payload?.status === 'validated' &&
        typeof payload.identity === 'object' &&
        (!expectedAgentId || JSON.stringify(payload.identity).includes(expectedAgentId))
    ),
    runCommand(
      'organization',
      'node',
      [
        'dist/scripts/organization_operating_model.js',
        'init',
        '--organization-id',
        ORGANIZATION_ID,
        '--name',
        'First Win Smoke Organization',
        '--tier',
        'personal',
        '--purpose',
        'Validate the first lifecycle path',
        '--dry-run',
        '--json',
      ],
      (payload, raw) =>
        payload?.mode === 'dry_run' &&
        Array.isArray(payload.saved_paths) &&
        payload.saved_paths.length === 0 &&
        raw.includes(ORGANIZATION_ID)
    ),
    runCommand(
      'project',
      'node',
      [
        'dist/scripts/project_controller.js',
        'create',
        '--project-id',
        PROJECT_ID,
        '--name',
        'First Win Smoke Project',
        '--summary',
        'Validate project attachment in the lifecycle path',
        '--tier',
        'personal',
        '--organization-id',
        ORGANIZATION_ID,
        '--project-path',
        PROJECT_PATH,
        '--dry-run',
        '--json',
      ],
      (payload) =>
        payload?.project_id === PROJECT_ID &&
        payload.organization_id === ORGANIZATION_ID &&
        payload.tier === 'personal'
    ),
    runCommand(
      'mission',
      'node',
      [
        'dist/scripts/mission_controller.js',
        'create',
        MISSION_ID,
        '--tier',
        'personal',
        '--organization-id',
        ORGANIZATION_ID,
        '--project-id',
        PROJECT_ID,
        '--project-path',
        PROJECT_PATH,
        '--project-relationship',
        'belongs_to',
        '--dry-run',
      ],
      (payload, raw) =>
        payload?.action === 'create' &&
        payload.mission_id === MISSION_ID &&
        raw.includes(ORGANIZATION_ID) &&
        raw.includes(PROJECT_ID) &&
        raw.includes(PROJECT_PATH)
    ),
    runScheduleStage(),
  ];
  stages.push(runHintsStage(stages));
  return {
    mode: 'dry-run',
    status: stages.every((stage) => stage.status === 'passed') ? 'passed' : 'failed',
    stages: stages.map(({ stage, status, detail }) => ({ stage, status, detail })),
  };
}

export function runFirstWinLifecycleLive(
  options: FirstWinLifecycleLiveOptions,
  runner: typeof safeExecResult = safeExecResult,
  readers: Partial<FirstWinLifecycleLiveReaders> = {}
): FirstWinLifecycleReport {
  const violations = validateFirstWinLifecycleLiveOptions(options);
  if (violations.length > 0) {
    return {
      mode: 'live',
      run_id: options.runId,
      status: 'failed',
      stages: [
        {
          stage: 'onboard',
          status: 'failed',
          detail: `live guard rejected: ${violations.join('; ')}`,
        },
      ],
    };
  }

  const plan = buildFirstWinLifecycleLivePlan(options);
  const resolvedReaders = resolveLiveReaders(readers);
  try {
    const conflicts = findFirstWinLifecycleLiveConflicts(plan, resolvedReaders);
    if (conflicts.length > 0) {
      return {
        mode: 'live',
        run_id: plan.runId,
        status: 'failed',
        stages: [
          {
            stage: 'onboard',
            status: 'failed',
            detail: `live preflight rejected run-id collision: ${conflicts.join('; ')}`,
          },
        ],
      };
    }
  } catch (error) {
    return {
      mode: 'live',
      run_id: plan.runId,
      status: 'failed',
      stages: [
        {
          stage: 'onboard',
          status: 'failed',
          detail: `live preflight could not inspect existing state: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }
  let identity: { identity?: { agent_id?: string } };
  try {
    identity = JSON.parse(
      String(safeReadFile(pathResolver.rootResolve(plan.identityFile), { encoding: 'utf8' }))
    ) as { identity?: { agent_id?: string } };
  } catch (error) {
    return {
      mode: 'live',
      run_id: plan.runId,
      status: 'failed',
      stages: [
        {
          stage: 'onboard',
          status: 'failed',
          detail: `live preflight could not read identity: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }
  const expectedAgentId = identity.identity?.agent_id || '';
  const stages: StageObservation[] = [];
  const appendStage = (stage: StageObservation): boolean => {
    stages.push(stage);
    return stage.status === 'passed';
  };
  const report = (): FirstWinLifecycleReport => ({
    mode: 'live',
    run_id: plan.runId,
    status: stages.every((stage) => stage.status === 'passed') ? 'passed' : 'failed',
    stages: stages.map(({ stage, status, detail }) => ({ stage, status, detail })),
  });

  if (
    !appendStage(
      runLiveCommand(
        'onboard',
        'node',
        ['dist/scripts/onboarding_apply.js', '--identity', plan.identityFile, '--json'],
        (payload) =>
          payload?.status === 'complete' &&
          (!expectedAgentId || payload.agent_id === expectedAgentId),
        runner
      )
    )
  )
    return report();
  if (
    !appendStage(
      runLiveCommand(
        'organization',
        'node',
        [
          'dist/scripts/organization_operating_model.js',
          'init',
          '--organization-id',
          plan.organizationId,
          '--name',
          `First Win Live ${plan.runId}`,
          '--tier',
          'personal',
          '--purpose',
          'Validate the first lifecycle path in a governed live environment',
          '--apply',
          '--json',
        ],
        (payload) => payload?.mode === 'apply' && Array.isArray(payload.saved_paths),
        runner
      )
    )
  )
    return report();
  if (
    !appendStage(
      runLiveCommand(
        'project',
        'node',
        [
          'dist/scripts/project_controller.js',
          'create',
          '--project-id',
          plan.projectId,
          '--name',
          `First Win Live ${plan.runId}`,
          '--summary',
          'Validate the project path in the live lifecycle acceptance',
          '--tier',
          'personal',
          '--organization-id',
          plan.organizationId,
          '--project-path',
          plan.projectPath,
          '--json',
        ],
        (payload) => payload?.project_id === plan.projectId,
        runner
      )
    )
  )
    return report();
  if (
    !appendStage(
      runLiveCommand(
        'project',
        'node',
        [
          'dist/scripts/organization_operating_model.js',
          'project',
          'attach',
          '--organization-id',
          plan.organizationId,
          '--project-id',
          plan.projectId,
          '--tier',
          'personal',
          '--apply',
          '--json',
        ],
        (payload) => payload?.mode === 'apply' && Array.isArray(payload.saved_paths),
        runner
      )
    )
  )
    return report();

  const missionCommands: Array<{ args: string[]; detail: string }> = [
    {
      args: [
        'dist/scripts/mission_controller.js',
        'create',
        plan.missionId,
        '--tier',
        'personal',
        '--organization-id',
        plan.organizationId,
        '--project-id',
        plan.projectId,
        '--project-path',
        plan.projectPath,
        '--project-relationship',
        'belongs_to',
        '--ephemeral',
        '--goal',
        'Validate the first lifecycle path',
        '--success-condition',
        'The governed live lifecycle completes through finish',
      ],
      detail: 'mission created',
    },
    {
      args: [
        'dist/scripts/mission_controller.js',
        'start',
        plan.missionId,
        '--tier',
        'personal',
        '--organization-id',
        plan.organizationId,
        '--project-id',
        plan.projectId,
        '--project-path',
        plan.projectPath,
        '--ephemeral',
      ],
      detail: 'mission started',
    },
    {
      args: [
        'dist/scripts/mission_controller.js',
        'verify',
        plan.missionId,
        'verified',
        'First-Win live lifecycle acceptance evidence recorded',
      ],
      detail: 'mission verified',
    },
    {
      args: ['dist/scripts/mission_controller.js', 'distill', plan.missionId],
      detail: 'mission distilled',
    },
    {
      args: ['dist/scripts/mission_controller.js', 'finish', plan.missionId],
      detail: 'mission finished',
    },
  ];
  const expectedMissionStatuses = ['planned', 'active', 'distilling', 'completed', 'archived'];
  for (const command of missionCommands) {
    const result = runLiveCommand(
      'mission',
      'node',
      command.args,
      (_payload, raw) => validateMissionLiveOutput(command.args[1] || '', plan.missionId, raw),
      runner,
      `validated mission ${command.detail} output`
    );
    appendStage({ ...result, detail: `${command.detail}: ${result.detail}` });
    if (result.status === 'failed') return report();
    const expectedStatus = expectedMissionStatuses[missionCommands.indexOf(command)];
    let actualStatus: string | undefined;
    try {
      actualStatus = resolvedReaders.missionState(plan.missionId)?.status;
    } catch (error) {
      actualStatus = undefined;
      stages[stages.length - 1] = {
        ...stages[stages.length - 1],
        status: 'failed',
        detail: `${command.detail}: state verification raised an exception: ${error instanceof Error ? error.message : String(error)}`,
      };
      return report();
    }
    if (actualStatus !== expectedStatus) {
      stages[stages.length - 1] = {
        ...stages[stages.length - 1],
        status: 'failed',
        detail: `${command.detail}: state verification failed (expected ${expectedStatus}, got ${actualStatus || 'missing'})`,
      };
      return report();
    }
  }

  appendStage(
    runLiveCommand(
      'schedule',
      'pnpm',
      ['pipeline', '--input', LIFECYCLE_PIPELINE],
      (payload, raw) => payload?.status === 'passed' || raw.includes('"status": "passed"'),
      runner,
      'executed lifecycle pipeline; scheduler trigger not exercised'
    )
  );
  appendStage(runHintsStage(stages));
  return report();
}

export function main(): void {
  if (process.argv.includes('--live')) {
    const identityIndex = process.argv.indexOf('--identity');
    const runIdIndex = process.argv.indexOf('--run-id');
    const confirmIndex = process.argv.indexOf('--confirm-live');
    const options: FirstWinLifecycleLiveOptions = {
      identityFile: identityIndex >= 0 ? process.argv[identityIndex + 1] || '' : '',
      runId: runIdIndex >= 0 ? process.argv[runIdIndex + 1] || '' : '',
      confirm: confirmIndex >= 0 ? process.argv[confirmIndex + 1] || '' : '',
      allowWrites: process.env.KYBERION_FIRST_WIN_LIVE,
    };
    const report = runFirstWinLifecycleLive(options);
    console.log(JSON.stringify(report, null, 2));
    if (report.status !== 'passed') process.exitCode = 1;
    return;
  }
  if (!process.argv.includes('--dry-run')) {
    console.error('first_win_lifecycle_smoke requires --dry-run or --live');
    process.exitCode = 2;
    return;
  }
  const report = runFirstWinLifecycleDryRun();
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== 'passed') process.exitCode = 1;
}

if (process.argv[1]?.endsWith('first_win_lifecycle_smoke.js')) main();
