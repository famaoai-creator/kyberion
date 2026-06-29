#!/usr/bin/env node
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathResolver, safeExistsSync, safeLstat, safeMkdir, safeReadFile, safeReaddir, safeWriteFile } from '@agent/core';

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
  console.log('Usage: pnpm task:init <scenario-id> [--answers-json <json>] [--answers-file <path>]');
  console.log('  pnpm task:init <scenario-id> --print-template');
}

function resolveScenarioDir(): string {
  const override = process.env.KYBERION_TASK_SCENARIO_DIR?.trim();
  return override ? path.resolve(override) : DEFAULT_SCENARIO_DIR;
}

function loadScenarioFiles(scenarioDir = resolveScenarioDir()): string[] {
  if (!safeExistsSync(scenarioDir) || !safeLstat(scenarioDir).isDirectory()) {
    return [];
  }
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

function loadAnswers(args: TaskInitArgs): Record<string, unknown> {
  if (args.answersFile) {
    return JSON.parse(safeReadFile(pathResolver.rootResolve(args.answersFile), { encoding: 'utf8' }) as string) as Record<string, unknown>;
  }
  if (args.answersJson) {
    return JSON.parse(args.answersJson) as Record<string, unknown>;
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
  const resolved = pathResolver.rootResolve(profileOutput);
  if (!resolved.startsWith(pathResolver.rootDir())) {
    throw new Error(`Profile output resolved outside the workspace: ${profileOutput}`);
  }
}

function buildProfile(scenario: TaskScenario, answers: Record<string, unknown>) {
  const firstRunAnswers: Record<string, unknown> = {};
  for (const question of scenario.first_run.questions) {
    firstRunAnswers[question] = answers[question] ?? answers[question.replace(/\?+$/, '')] ?? null;
  }

  return {
    scenario_id: scenario.id,
    scenario_title: scenario.title,
    created_at: new Date().toISOString(),
    answers,
    first_run_answers: firstRunAnswers,
    repeat_run: scenario.repeat_run,
    approval_boundary: scenario.approval_boundary,
  };
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
  const profilePath = pathResolver.rootResolve(scenario.first_run.profile_output);

  safeMkdir(path.dirname(profilePath), { recursive: true });
  safeWriteFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`);

  console.log(`Created profile: ${scenario.first_run.profile_output}`);
  console.log(`Next: pnpm task:run ${scenario.id}`);
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  main().catch((err) => {
    console.error(err?.message ?? String(err));
    process.exit(1);
  });
}
