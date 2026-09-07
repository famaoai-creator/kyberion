#!/usr/bin/env node

import { pathResolver } from '@agent/core/path-resolver';
import { safeExecResult } from '@agent/core/secure-io';
import {
  currentProcessArgv,
  defineScript,
  isDirectScript,
  ScriptExitError,
} from './lib/harness.js';

export const TEST_SUITES = {
  smoke: ['tests/smoke.test.ts'],
  unit: ['libs/core/', 'libs/actuators/'],
  core: ['libs/core/', '--no-file-parallelism'],
  'meeting-dry-run': [
    'libs/core/meeting-participation-coordinator.test.ts',
    'libs/actuators/meeting-browser-driver/src/index.test.ts',
  ],
  'ui-voice-browser-smoke': [
    'tests/voice-browser-smoke-contract.test.ts',
    'scripts/check_first_win_smoke.test.ts',
    'libs/actuators/meeting-actuator/src/index.test.ts',
  ],
  actuators: ['libs/actuators/'],
  scripts: ['scripts/'],
  integration: ['tests/'],
  'browser-bridge': [
    'tests/browser-bridge-extension.test.ts',
    'tests/browser-bridge-a11y.test.ts',
    'tests/browser-bridge-built-in-ai.test.ts',
  ],
  'meet-copilot': [
    'tests/meet-copilot-extension.test.ts',
    'tests/meet-copilot-built-in-ai.test.ts',
    'libs/core/chrome-extension-meeting-driver.test.ts',
  ],
  coverage: ['--coverage'],
  tui: ['presence/displays/terminal-hud/'],
} as const satisfies Record<string, readonly string[]>;

export type TestSuite = keyof typeof TEST_SUITES;

export function parseTestSuiteArgs(argv: readonly string[]): {
  suite: TestSuite;
  vitestArgs: string[];
} {
  let suite: TestSuite = 'smoke';
  const vitestArgs: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (arg === '--suite') {
      const value = argv[index + 1];
      if (!value) throw new Error('--suite requires a suite name');
      suite = asTestSuite(value);
      index += 1;
    } else if (arg.startsWith('--suite=')) {
      suite = asTestSuite(arg.slice('--suite='.length));
    } else {
      vitestArgs.push(arg);
    }
  }
  return { suite, vitestArgs };
}

function asTestSuite(value: string): TestSuite {
  if (Object.hasOwn(TEST_SUITES, value)) return value as TestSuite;
  throw new Error(
    `unknown test suite: ${value}. Choose one of ${Object.keys(TEST_SUITES).join(', ')}`
  );
}

export function buildVitestArgs(suite: TestSuite, extraArgs: readonly string[] = []): string[] {
  const suiteArgs = [...TEST_SUITES[suite]];
  const options = suite === 'core' ? [...suiteArgs.splice(-1), ...extraArgs] : extraArgs;
  return ['vitest', 'run', ...suiteArgs, ...options];
}

export function runTestSuite(argv: readonly string[]): number {
  const { suite, vitestArgs } = parseTestSuiteArgs(argv);
  const args = buildVitestArgs(suite, vitestArgs);
  const vitestEntry = pathResolver.rootResolve('node_modules/vitest/vitest.mjs');
  const result = safeExecResult(process.execPath, [vitestEntry, ...args.slice(1)], {
    cwd: pathResolver.rootDir(),
    // The core suite streams steadily for ~15min on the slowest shared
    // runners (ubuntu); the old 900s cap SIGTERMed healthy runs (exit 143).
    // Keep the cap below the smallest job timeout (cross-os: 25min) so the
    // workflow backstop still fires first on a genuine hang.
    timeoutMs: 1_380_000,
    maxOutputMB: 50,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    throw new ScriptExitError(
      result.status ?? 1,
      `test suite ${suite} failed (exit=${String(result.status)})`,
      true
    );
  }
  return 0;
}

if (
  isDirectScript(import.meta.url, 'test_suite.ts') ||
  isDirectScript(import.meta.url, 'test_suite.js')
) {
  void defineScript({
    name: 'test',
    flags: [],
    run: (context) => runTestSuite(context.argv),
  })(currentProcessArgv().slice(2));
}
