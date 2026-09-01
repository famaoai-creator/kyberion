#!/usr/bin/env node
import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeReaddir,
} from '@agent/core/secure-io';
import { getRegisteredEnvText } from '@agent/core/foundation';
import { defineScript, isDirectScript } from './lib/harness.js';
import { loadTaskRecord, loadTaskScenario, type TaskScenario } from './lib/task-scenario.js';

type TaskRunArgs = {
  scenarioId?: string;
  profile?: string;
  dryRun: boolean;
  help?: boolean;
};

type TaskRunOptions = {
  allowExternalProfilePath?: boolean;
};

const DEFAULT_SCENARIO_DIR = pathResolver.rootResolve('knowledge/product/task-scenarios');
const PERSONAL_TASK_PROFILE_DIR = pathResolver.rootResolve('knowledge/personal/task-profiles');

function resolveScenarioDir(): string {
  const override = getRegisteredEnvText('KYBERION_TASK_SCENARIO_DIR')?.trim();
  return override
    ? assertSafeRepositoryPath(path.resolve(override), { allowMissingLeaf: true })
    : DEFAULT_SCENARIO_DIR;
}

function loadScenarioFiles(scenarioDir = resolveScenarioDir()): string[] {
  const safeScenarioDir = assertSafeRepositoryPath(scenarioDir, { allowMissingLeaf: true });
  if (!safeExistsSync(safeScenarioDir) || !safeLstat(safeScenarioDir).isDirectory()) return [];
  return safeReaddir(safeScenarioDir)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => assertSafeRepositoryPath(path.join(safeScenarioDir, entry)))
    .filter((filePath) => safeLstat(filePath).isFile())
    .sort((left, right) => left.localeCompare(right));
}

function loadScenario(filePath: string): TaskScenario {
  return loadTaskScenario(filePath);
}

function loadScenarioById(scenarioId: string): TaskScenario | undefined {
  return loadScenarioFiles()
    .map(loadScenario)
    .find((scenario) => scenario.id === scenarioId);
}

function parseArgs(argv: string[]): TaskRunArgs {
  const args = [...argv];
  const parsed: TaskRunArgs = { dryRun: true };

  if (args.length > 0 && (args[0] === 'help' || args[0] === '--help' || args[0] === '-h')) {
    parsed.help = true;
    return parsed;
  }
  if (args.length > 0 && !args[0].startsWith('--')) {
    parsed.scenarioId = args.shift();
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--profile') {
      parsed.profile = args[++i];
    } else if (arg === '--dry-run') {
      parsed.dryRun = true;
    }
  }

  return parsed;
}

export function taskRunUsage(): string {
  return 'Usage: pnpm task:run <scenario-id> [--profile <path>] [--dry-run]';
}

function resolveProfilePath(
  scenario: TaskScenario,
  override?: string,
  options: TaskRunOptions = {}
): string {
  const resolved = assertSafeRepositoryPath(
    pathResolver.rootResolve(override || scenario.first_run.profile_output),
    { allowMissingLeaf: true }
  );
  const relative = path.relative(pathResolver.rootDir(), resolved);
  if (relative.startsWith('..')) {
    throw new Error(
      `Profile path must stay within the workspace: ${override || scenario.first_run.profile_output}`
    );
  }
  if (options.allowExternalProfilePath) {
    return resolved;
  }
  const personalProfileRelative = path.relative(PERSONAL_TASK_PROFILE_DIR, resolved);
  if (personalProfileRelative.startsWith('..') || path.isAbsolute(personalProfileRelative)) {
    throw new Error(
      `Profile path must stay within knowledge/personal/task-profiles/: ${override || scenario.first_run.profile_output}`
    );
  }
  return resolved;
}

function loadProfile(profilePath: string): Record<string, unknown> {
  return loadTaskRecord(profilePath, 'TaskScenario profile');
}

function renderApprovalBoundary(boundary: TaskScenario['approval_boundary']): string {
  const requiredFor = boundary.required_for.length > 0 ? boundary.required_for.join(', ') : 'none';
  return `${boundary.default_action} (required for: ${requiredFor})`;
}

function formatArtifactHint(artifact: string): string {
  if (artifact.startsWith('active/')) {
    return artifact;
  }
  return `active/shared/tmp/${artifact}`;
}

export function describeTaskRun(
  scenarioId: string,
  profileOverride?: string,
  options: TaskRunOptions = {}
): string {
  const scenario = loadScenarioById(scenarioId);
  if (!scenario) {
    throw new Error(`Unknown TaskScenario: ${scenarioId}`);
  }

  const profilePath = resolveProfilePath(scenario, profileOverride, options);
  const profileLoaded = safeExistsSync(profilePath) && safeLstat(profilePath).isFile();
  const requiresProfile = scenario.repeat_run.params_from_profile;

  const profile = profileLoaded ? loadProfile(profilePath) : null;
  const artifactList = scenario.result.artifacts
    .flatMap((artifact) => [`- ${artifact}`, `  Likely path: ${formatArtifactHint(artifact)}`])
    .join('\n');
  const nextActions =
    requiresProfile && !profileLoaded
      ? [
          `1. Run pnpm task:init ${scenario.id} to create the profile.`,
          `2. Review the generated profile.`,
          `3. Re-run pnpm task:run ${scenario.id} --dry-run.`,
        ]
      : [
          `1. Review the plan and expected artifacts.`,
          `2. When you are ready to execute for real, run the task executor.`,
        ];

  return [
    `TaskScenario: ${scenario.id}`,
    `Status: dry-run only; no external side effects`,
    `Title: ${scenario.title}`,
    `Description: ${scenario.description}`,
    `Inputs:`,
    `- Sources: ${scenario.input.sources.join(', ')}`,
    `- Profile: ${profilePath}`,
    profile ? `Profile loaded: yes` : 'Profile loaded: no',
    `- Pipeline template: ${scenario.repeat_run.pipeline_template}`,
    `Expected result:`,
    artifactList,
    `Approval required before:`,
    `- ${renderApprovalBoundary(scenario.approval_boundary)}`,
    `Next actions:`,
    ...nextActions.map((action) => `- ${action}`),
  ].join('\n');
}

export async function main(
  argv: string[] = [],
  print: (value: unknown) => void = () => undefined,
  json = false
): Promise<void> {
  const args = parseArgs(argv);
  if (args.help) {
    print(taskRunUsage());
    return;
  }
  if (!args.scenarioId) {
    print(taskRunUsage());
    throw new Error('Missing scenario id');
  }

  const plan = describeTaskRun(args.scenarioId, args.profile);
  print(json ? { status: 'ok', scenarioId: args.scenarioId, dryRun: true, plan } : plan);

  const scenario = loadScenarioById(args.scenarioId);
  if (!scenario) {
    throw new Error(`Unknown TaskScenario: ${args.scenarioId}`);
  }

  const profilePath = resolveProfilePath(scenario, args.profile);
  if (scenario.repeat_run.params_from_profile && !safeExistsSync(profilePath)) {
    throw new Error(`Missing profile for ${scenario.id}. Run pnpm task:init ${scenario.id} first.`);
  }
}

const script = defineScript({
  name: 'task:run',
  flags: ['json', 'dry-run', 'quiet'],
  run: ({ argv, print, json }) => main(argv, print, json),
});
if (
  isDirectScript(import.meta.url, 'task_run.ts') ||
  isDirectScript(import.meta.url, 'task_run.js')
) {
  void script();
}
