#!/usr/bin/env node
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathResolver, safeExistsSync, safeLstat, safeReadFile, safeReaddir } from '@agent/core';

type TaskTrigger =
  | { type: 'schedule'; cron: string; timezone?: string }
  | { type: 'event'; event_name: string; source?: string }
  | { type: 'manual'; prompt: string };

type TaskScenario = {
  id: string;
  title: string;
  description: string;
  trigger: TaskTrigger;
  input: {
    sources: string[];
    required_params: string[];
    optional_params?: string[];
  };
  first_run: {
    reasoning_required: boolean;
    questions: string[];
    profile_output: string;
  };
  repeat_run: {
    pipeline_template: string;
    params_from_profile: boolean;
    profile_input?: string;
  };
  result: {
    artifacts: string[];
    summary_format: 'markdown' | 'json' | 'text';
  };
  approval_boundary: {
    required_for: string[];
    default_action: 'draft-only' | 'notify-only' | 'requires-human-approval';
  };
};

const DEFAULT_SCENARIO_DIR = pathResolver.rootResolve('knowledge/product/task-scenarios');

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

function formatRepeatTrigger(trigger: TaskScenario['trigger']): string {
  if (trigger.type === 'schedule') {
    return `schedule ${trigger.cron}${trigger.timezone ? ` (${trigger.timezone})` : ''}`;
  }
  if (trigger.type === 'event') {
    return `event ${trigger.event_name}${trigger.source ? ` via ${trigger.source}` : ''}`;
  }
  return `manual: ${trigger.prompt}`;
}

function formatScenarioSummary(scenario: TaskScenario): string[] {
  const firstRunSummary = scenario.first_run.questions.length
    ? `${scenario.first_run.questions.length} preference${scenario.first_run.questions.length === 1 ? '' : 's'}`
    : 'no extra preferences';
  const repeatSummary = formatRepeatTrigger(scenario.trigger);
  const artifacts = scenario.result.artifacts.join(' + ');

  return [
    `- ${scenario.id}`,
    `  Title: ${scenario.title}`,
    `  Result: ${artifacts}`,
    `  First run: needs ${firstRunSummary}`,
    `  Repeat: ${repeatSummary}`,
  ];
}

export function listTaskScenarios(scenarioDir = resolveScenarioDir()): TaskScenario[] {
  const files = loadScenarioFiles(scenarioDir);
  return files.map(loadScenario);
}

export function printTaskScenarios(scenarios: TaskScenario[]): void {
  if (scenarios.length === 0) {
    console.error(
      `No TaskScenario files found under ${path.relative(pathResolver.rootDir(), resolveScenarioDir()) || resolveScenarioDir()}.`
    );
    console.error('Add at least one JSON file to knowledge/product/task-scenarios/*.json and run pnpm task:list again.');
    process.exitCode = 1;
    return;
  }

  console.log('Available repeatable tasks:\n');
  for (const scenario of scenarios) {
    console.log(formatScenarioSummary(scenario).join('\n'));
    console.log('');
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = [...argv];
  const json = args.includes('--json');
  if (json) {
    const scenarios = listTaskScenarios();
    console.log(JSON.stringify(scenarios, null, 2));
    return;
  }

  const scenarios = listTaskScenarios();
  printTaskScenarios(scenarios);
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  main().catch((err) => {
    console.error(err?.message ?? String(err));
    process.exit(1);
  });
}
