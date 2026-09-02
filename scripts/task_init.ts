#!/usr/bin/env node
import * as path from 'node:path';
import { getRegisteredEnv } from '@agent/core/foundation/env';
import { nowIso } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeReaddir,
  safeWriteFile,
} from '@agent/core/secure-io';
import { defineScript, isDirectScript } from './lib/harness.js';
import {
  loadTaskRecord,
  loadTaskScenario,
  parseTaskRecord,
  type TaskScenario,
} from './lib/task-scenario.js';
import { parseSafeJsonInput } from './lib/json-input.js';

const DEFAULT_SCENARIO_DIR = pathResolver.rootResolve('knowledge/product/task-scenarios');

interface TaskInitArgs {
  scenarioId?: string;
  answers?: Record<string, unknown>;
  answersFile?: string;
  answersJson?: string;
  printTemplate?: boolean;
  help?: boolean;
}

function parseArgs(argv: string[]): TaskInitArgs {
  const args = [...argv];
  const parsed: TaskInitArgs = { answers: {} };

  if (args.length > 0 && (args[0] === 'help' || args[0] === '--help' || args[0] === '-h')) {
    parsed.help = true;
    return parsed;
  }
  if (args.length > 0 && !args[0].startsWith('--')) {
    parsed.scenarioId = args.shift();
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--answers-file') {
      parsed.answersFile = args[++i];
    } else if (arg === '--answers-json') {
      parsed.answersJson = args[++i];
    } else if (arg === '--print-template') {
      parsed.printTemplate = true;
    } else if (arg === '--scenario') {
      parsed.scenarioId = args[++i];
    }
  }

  return parsed;
}

function printUsage(): void {
  console.log(
    'Usage: pnpm task:init <scenario-id> [--answers-json <json>] [--answers-file <path>]'
  );
  console.log('  pnpm task:init <scenario-id> --print-template');
}

function resolveScenarioDir(): string {
  const override = (
    getRegisteredEnv<string>('KYBERION_TASK_SCENARIO_DIR') as string | undefined
  )?.trim();
  return override
    ? assertSafeRepositoryPath(path.resolve(override), { allowMissingLeaf: true })
    : DEFAULT_SCENARIO_DIR;
}

function loadScenarioFiles(scenarioDir = resolveScenarioDir()): string[] {
  const safeScenarioDir = assertSafeRepositoryPath(scenarioDir, { allowMissingLeaf: true });
  if (!safeExistsSync(safeScenarioDir) || !safeLstat(safeScenarioDir).isDirectory()) {
    return [];
  }
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

function loadAnswers(args: TaskInitArgs): Record<string, unknown> {
  if (args.answersFile) {
    const answersPath = assertSafeRepositoryPath(pathResolver.resolve(args.answersFile));
    if (!safeExistsSync(answersPath) || !safeLstat(answersPath).isFile()) {
      throw new Error(
        `[task:init] answers file must be an existing regular file: ${args.answersFile}`
      );
    }
    return loadTaskRecord(answersPath, 'TaskScenario answers');
  }
  if (args.answersJson) {
    return parseTaskRecord(
      parseSafeJsonInput(args.answersJson, 'TaskScenario answers'),
      'TaskScenario answers'
    );
  }
  return args.answers || {};
}

function buildAnswerTemplate(scenario: TaskScenario): Record<string, string> {
  return scenario.first_run.questions.reduce<Record<string, string>>((template, question) => {
    template[question] = '';
    return template;
  }, {});
}

function assertProfilePathAllowed(profileOutput: string): void {
  const normalized = profileOutput.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized.startsWith('knowledge/personal/')) {
    throw new Error(`Profile output must stay under knowledge/personal/: ${profileOutput}`);
  }
  assertSafeRepositoryPath(pathResolver.rootResolve(profileOutput), { allowMissingLeaf: true });
}

function buildProfile(scenario: TaskScenario, answers: Record<string, unknown>) {
  const firstRunAnswers: Record<string, unknown> = {};
  for (const question of scenario.first_run.questions) {
    firstRunAnswers[question] = answers[question] ?? answers[question.replace(/\?+$/, '')] ?? null;
  }

  return {
    scenario_id: scenario.id,
    scenario_title: scenario.title,
    created_at: nowIso(),
    answers,
    first_run_answers: firstRunAnswers,
    repeat_run: scenario.repeat_run,
    approval_boundary: scenario.approval_boundary,
  };
}

export async function main(argv: string[] = []): Promise<void> {
  const args = parseArgs(argv);
  if (args.help) {
    printUsage();
    return;
  }
  if (!args.scenarioId) {
    printUsage();
    throw new Error('Missing scenario id');
  }

  const scenario = loadScenarioById(args.scenarioId);
  if (!scenario) {
    throw new Error(`Unknown TaskScenario: ${args.scenarioId}`);
  }

  if (args.printTemplate) {
    console.log(JSON.stringify(buildAnswerTemplate(scenario), null, 2));
    return;
  }

  assertProfilePathAllowed(scenario.first_run.profile_output);
  const answers = loadAnswers(args);
  const profile = buildProfile(scenario, answers);
  const profilePath = assertSafeRepositoryPath(
    pathResolver.rootResolve(scenario.first_run.profile_output),
    { allowMissingLeaf: true }
  );

  safeMkdir(path.dirname(profilePath), { recursive: true });
  safeWriteFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`);

  console.log(`Created profile: ${scenario.first_run.profile_output}`);
  console.log(`Next: pnpm task:run ${scenario.id}`);
}

export const runTaskInit = defineScript({
  name: 'task:init',
  flags: [],
  run: (context) => main(context.argv),
});

if (
  isDirectScript(import.meta.url, 'task_init.ts') ||
  isDirectScript(import.meta.url, 'task_init.js')
)
  void runTaskInit();
