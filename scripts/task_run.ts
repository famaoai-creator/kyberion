#!/usr/bin/env node
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathResolver, safeExistsSync, safeReadFile, safeLstat, safeReaddir } from '@agent/core';

type TaskScenario = {
  id: string;
  title: string;
  description: string;
  trigger: { type: 'schedule' | 'event' | 'manual'; cron?: string; timezone?: string; event_name?: string; source?: string; prompt?: string };
  input: { sources: string[]; required_params: string[]; optional_params?: string[] };
  first_run: { reasoning_required: boolean; questions: string[]; profile_output: string };
  repeat_run: { pipeline_template: string; params_from_profile: boolean; profile_input?: string };
  result: { artifacts: string[]; summary_format: 'markdown' | 'json' | 'text' };
  approval_boundary: { required_for: string[]; default_action: 'draft-only' | 'notify-only' | 'requires-human-approval' };
};

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
  const override = process.env.KYBERION_TASK_SCENARIO_DIR?.trim();
  return override ? path.resolve(override) : DEFAULT_SCENARIO_DIR;
}

function loadScenarioFiles(scenarioDir = resolveScenarioDir()): string[] {
  if (!safeExistsSync(scenarioDir) || !safeLstat(scenarioDir).isDirectory()) return [];
  return safeReaddir(scenarioDir)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => path.join(scenarioDir, entry))
    .sort((left, right) => left.localeCompare(right));
}

function loadScenario(filePath: string): TaskScenario {
  return JSON.parse(safeReadFile(filePath, { encoding: 'utf8' }) as string) as TaskScenario;
}

function loadScenarioById(scenarioId: string): TaskScenario | undefined {
  return loadScenarioFiles().map(loadScenario).find((scenario) => scenario.id === scenarioId);
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

function printUsage(): void {
  console.log('Usage: pnpm task:run <scenario-id> [--profile <path>] [--dry-run]');
}

function resolveProfilePath(scenario: TaskScenario, override?: string, options: TaskRunOptions = {}): string {
  const resolved = pathResolver.rootResolve(override || scenario.first_run.profile_output);
  const relative = path.relative(pathResolver.rootDir(), resolved);
  if (relative.startsWith('..')) {
    throw new Error(`Profile path must stay within the workspace: ${override || scenario.first_run.profile_output}`);
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
  return JSON.parse(safeReadFile(profilePath, { encoding: 'utf8' }) as string) as Record<string, unknown>;
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

export function describeTaskRun(scenarioId: string, profileOverride?: string, options: TaskRunOptions = {}): string {
  const scenario = loadScenarioById(scenarioId);
  if (!scenario) {
    throw new Error(`Unknown TaskScenario: ${scenarioId}`);
  }

  const profilePath = resolveProfilePath(scenario, profileOverride, options);
  const profileLoaded = safeExistsSync(profilePath);
  const requiresProfile = scenario.repeat_run.params_from_profile;

  const profile = profileLoaded ? loadProfile(profilePath) : null;
  const artifactList = scenario.result.artifacts
    .flatMap((artifact) => [`- ${artifact}`, `  Likely path: ${formatArtifactHint(artifact)}`])
    .join('\n');
  const nextActions = requiresProfile && !profileLoaded
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

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  if (args.help) {
    printUsage();
    return;
  }
  if (!args.scenarioId) {
    printUsage();
    throw new Error('Missing scenario id');
  }

  const plan = describeTaskRun(args.scenarioId, args.profile);
  console.log(plan);

  const scenario = loadScenarioById(args.scenarioId);
  if (!scenario) {
    throw new Error(`Unknown TaskScenario: ${args.scenarioId}`);
  }

  const profilePath = resolveProfilePath(scenario, args.profile);
  if (scenario.repeat_run.params_from_profile && !safeExistsSync(profilePath)) {
    throw new Error(`Missing profile for ${scenario.id}. Run pnpm task:init ${scenario.id} first.`);
  }
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  main().catch((err) => {
    console.error(err?.message ?? String(err));
    process.exit(1);
  });
}
