#!/usr/bin/env node
import {
  extractHintsFromTrace,
  matchesCron,
  pathResolver,
  safeExecResult,
  safeReadFile,
} from '@agent/core';
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
  mode: 'dry-run';
  status: 'passed' | 'failed';
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
  validate: (payload: Record<string, unknown> | null, raw: string) => boolean
): StageObservation {
  const result = safeExecResult(command, args, {
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
      `${command} returned an unexpected dry-run contract: ${stdout.trim().slice(-500)}`,
      stdout,
      stderr
    );
  }
  return observation(
    stage,
    'passed',
    'validated machine-readable dry-run contract',
    stdout,
    stderr
  );
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

export function main(): void {
  if (!process.argv.includes('--dry-run')) {
    console.error('first_win_lifecycle_smoke requires --dry-run');
    process.exitCode = 2;
    return;
  }
  const report = runFirstWinLifecycleDryRun();
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== 'passed') process.exitCode = 1;
}

if (process.argv[1]?.endsWith('first_win_lifecycle_smoke.js')) main();
