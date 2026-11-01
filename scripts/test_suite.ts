#!/usr/bin/env node

import { getRegisteredEnvText } from '@agent/core/foundation/env';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExecResult } from '@agent/core/secure-io';
import {
  currentProcessArgv,
  defineScript,
  isDirectScript,
  ScriptExitError,
} from './lib/harness.js';
import { readSafeJsonFile } from './lib/json-input.js';

export const TEST_SUITES = {
  smoke: ['tests/smoke.test.ts'],
  unit: ['libs/core/', 'libs/actuators/'],
  core: ['libs/core/', '--no-file-parallelism'],
  'meeting-dry-run': [
    'libs/core/meeting/meeting-participation-coordinator.test.ts',
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
    'libs/core/browser/chrome-extension-meeting-driver.test.ts',
  ],
  coverage: ['--coverage'],
  tui: ['presence/displays/terminal-hud/'],
} as const satisfies Record<string, readonly string[]>;

export type TestSuite = keyof typeof TEST_SUITES;

/**
 * `--skip-gate-tests`: leave out the test files a pr-scope ci gate already runs
 * through vitest (registration-tests). CI runs every pr gate on every event —
 * pr-validation.yml `--scope pr` on pull_request/merge_group, ci.yml
 * `--scope full` on push/schedule — so the integration suite need not repeat
 * them. Local runs without the flag still execute all of tests/.
 */
export const SKIP_GATE_TESTS_FLAG = '--skip-gate-tests';

interface GateTestManifest {
  gates: Array<{ id: string; scope: string; args?: string[] }>;
}

/** Test files run by pr-scope gates that invoke vitest directly. */
export function gateCoveredTestFiles(manifest: GateTestManifest): string[] {
  return [
    ...new Set(
      manifest.gates
        .filter(
          (gate) => gate.scope === 'pr' && gate.args?.some((arg) => arg.endsWith('vitest.mjs'))
        )
        .flatMap((gate) => (gate.args ?? []).filter((arg) => /\.test\.tsx?$/u.test(arg)))
    ),
  ].sort();
}

export function parseTestSuiteArgs(argv: readonly string[]): {
  suite: TestSuite;
  vitestArgs: string[];
  skipGateTests?: true;
} {
  let suite: TestSuite = 'smoke';
  let skipGateTests = false;
  const vitestArgs: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (arg === SKIP_GATE_TESTS_FLAG) {
      skipGateTests = true;
    } else if (arg === '--suite') {
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
  return { suite, vitestArgs, ...(skipGateTests ? { skipGateTests: true as const } : {}) };
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

/**
 * Test-run switches the Vitest child must see. safeExec passes only its env
 * allowlist, so without this CI's KYBERION_TEST_LEAK_STRICT=1 never reached
 * tests/vitest-active-leak-guard.ts and leaks only warned.
 */
export function buildVitestEnv(
  env?: Record<string, string | undefined>
): Record<string, string | undefined> {
  return {
    KYBERION_TEST_LEAK_STRICT: getRegisteredEnvText('KYBERION_TEST_LEAK_STRICT', { env }),
  };
}

export function runTestSuite(argv: readonly string[]): number {
  const { suite, vitestArgs, skipGateTests } = parseTestSuiteArgs(argv);
  const excludes = skipGateTests
    ? gateCoveredTestFiles(
        readSafeJsonFile<GateTestManifest>(
          pathResolver.knowledge('product/governance/ci-gates.json'),
          'ci gate manifest'
        )
      ).flatMap((file) => ['--exclude', file])
    : [];
  const args = buildVitestArgs(suite, [...vitestArgs, ...excludes]);
  const vitestEntry = pathResolver.rootResolve('node_modules/vitest/vitest.mjs');
  const result = safeExecResult(process.execPath, [vitestEntry, ...args.slice(1)], {
    cwd: pathResolver.rootDir(),
    env: buildVitestEnv(),
    // The core suite streams steadily for 20min+ on the slowest shared
    // runners (ubuntu, worse with --coverage); lower caps SIGTERMed healthy
    // runs (exit 143). The workflows' own job timeouts remain the backstop
    // for genuine hangs (cross-os: 25min).
    timeoutMs: 2_400_000,
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
