#!/usr/bin/env node
import * as path from 'node:path';
import { getRegisteredEnv } from '@agent/core/foundation/env';
import { pathResolver } from '@agent/core/path-resolver';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeReaddir,
} from '@agent/core/secure-io';
import { defineScript, isDirectScript } from './lib/harness.js';
import { loadTaskScenario, type TaskScenario } from './lib/task-scenario.js';

const DEFAULT_SCENARIO_DIR = pathResolver.rootResolve('knowledge/product/task-scenarios');

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

function resolveProfilePath(scenario: TaskScenario): string {
  return assertSafeRepositoryPath(pathResolver.rootResolve(scenario.first_run.profile_output), {
    allowMissingLeaf: true,
  });
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

function formatReadiness(scenario: TaskScenario): { status: string; next: string } {
  const profilePath = resolveProfilePath(scenario);
  if (safeExistsSync(profilePath) && safeLstat(profilePath).isFile()) {
    return {
      status: 'ready for dry-run',
      next: `pnpm task:run ${scenario.id} --dry-run`,
    };
  }

  return {
    status: 'setup needed',
    next: `pnpm task:init ${scenario.id}`,
  };
}

function formatScenarioSummary(scenario: TaskScenario): string[] {
  const firstRunSummary = scenario.first_run.questions.length
    ? `${scenario.first_run.questions.length} preference${scenario.first_run.questions.length === 1 ? '' : 's'}`
    : 'no extra preferences';
  const repeatSummary = formatRepeatTrigger(scenario.trigger);
  const artifacts = scenario.result.artifacts.join(' + ');
  const readiness = formatReadiness(scenario);

  return [
    `- ${scenario.id}`,
    `  Title: ${scenario.title}`,
    `  Result: ${artifacts}`,
    `  Status: ${readiness.status}`,
    `  Next: ${readiness.next}`,
    `  First run: needs ${firstRunSummary}`,
    `  Repeat: ${repeatSummary}`,
  ];
}

export function listTaskScenarios(scenarioDir = resolveScenarioDir()): TaskScenario[] {
  const files = loadScenarioFiles(scenarioDir);
  return files.map(loadScenario);
}

export function formatTaskScenarios(scenarios: TaskScenario[]): string {
  if (scenarios.length === 0) {
    throw new Error('No repeatable TaskScenario definitions were found');
  }

  const lines = ['Available repeatable tasks:\n'];
  for (const scenario of scenarios) {
    lines.push(formatScenarioSummary(scenario).join('\n'), '');
  }
  return lines.join('\n');
}

export function printTaskScenarios(
  scenarios: TaskScenario[],
  print: (value: string) => void
): void {
  print(formatTaskScenarios(scenarios));
}

export async function main(
  _argv: string[] = [],
  print: (value: unknown) => void = () => undefined,
  json = false
): Promise<void> {
  if (json) {
    const scenarios = listTaskScenarios();
    print({ status: 'ok', scenarios });
    return;
  }

  const scenarios = listTaskScenarios();
  if (scenarios.length === 0) {
    // `task:list` is also the readiness probe used before `task:init`; an
    // empty catalog is an actionable state, not an uncaught CLI exception.
    print(
      `No TaskScenario files found under ${path.relative(pathResolver.rootDir(), resolveScenarioDir()) || resolveScenarioDir()}.\n` +
        'Add at least one JSON file to knowledge/product/task-scenarios/*.json and run pnpm task:list again.'
    );
    return;
  }
  printTaskScenarios(scenarios, (value) => print(value));
}

export const runTaskList = defineScript({
  name: 'task:list',
  flags: ['json', 'quiet'],
  run: (context) => main(context.argv, context.print, context.json),
});

if (
  isDirectScript(import.meta.url, 'task_list.ts') ||
  isDirectScript(import.meta.url, 'task_list.js')
)
  void runTaskList();
