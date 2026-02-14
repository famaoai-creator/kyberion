/**
 * TypeScript version of the test-genie skill.
 *
 * Detects test runners in a project directory and executes tests.
 * The CLI entry point remains in run.cjs; this module exports
 * typed helper functions for test runner detection and execution.
 *
 * Usage:
 *   import { detectTestRunner, runTests } from './run.js';
 *   const runner = detectTestRunner('/path/to/project', runners);
 *   const result = await runTests('/path/to/project', runner.command);
 */

import { exec } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SkillOutput } from '../../scripts/lib/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single detection rule used to identify a test runner. */
export interface DetectionRule {
  type:
    | 'file_exists'
    | 'directory_exists'
    | 'file_pattern'
    | 'package_json_script'
    | 'package_json_dep';
  path?: string;
  pattern?: string;
  script?: string;
  dependency?: string;
}

/** Configuration for a test runner loaded from the knowledge layer. */
export interface RunnerConfig {
  name: string;
  detection: DetectionRule[];
  command: string;
}

/** Execution settings controlling buffer size and timeout. */
export interface ExecutionConfig {
  max_buffer: number;
  timeout: number;
}

/** Full knowledge-layer configuration for test-genie. */
export interface TestGenieConfig {
  runners: RunnerConfig[];
  execution: ExecutionConfig;
}

/** Result of a test execution. */
export interface TestRunResult {
  targetDir: string;
  runner: string;
  command: string;
  duration: number;
  success: boolean;
  exitCode: number | undefined;
  stdout: string;
  stderr: string | undefined;
}

// ---------------------------------------------------------------------------
// Default fallback configuration
// ---------------------------------------------------------------------------

/** Default configuration used when the knowledge-layer YAML cannot be loaded. */
export const DEFAULT_CONFIG: TestGenieConfig = {
  runners: [
    {
      name: 'npm test',
      detection: [{ type: 'package_json_script', script: 'test' }],
      command: 'npm test',
    },
    {
      name: 'pytest',
      detection: [{ type: 'file_exists', path: 'pytest.ini' }],
      command: 'pytest',
    },
  ],
  execution: { max_buffer: 5_242_880, timeout: 300_000 },
};

// ---------------------------------------------------------------------------
// Detection helpers
// ---------------------------------------------------------------------------

/**
 * Evaluate a single detection rule against a target directory.
 *
 * @param detection - Detection rule to evaluate
 * @param targetDir - Absolute path to the project directory
 * @returns true if the rule matches
 */
export function checkDetection(detection: DetectionRule, targetDir: string): boolean {
  switch (detection.type) {
    case 'file_exists':
      return detection.path !== undefined && fs.existsSync(path.join(targetDir, detection.path));

    case 'directory_exists': {
      if (!detection.path) return false;
      const dirPath = path.join(targetDir, detection.path);
      return fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory();
    }

    case 'file_pattern':
      // Glob-based pattern matching requires the 'glob' CJS library.
      // In the TS layer we provide a simple fs-based fallback.
      if (!detection.pattern) return false;
      try {
        const dir = path.dirname(detection.pattern);
        const base = path.basename(detection.pattern);
        const searchDir = path.join(targetDir, dir === '.' ? '' : dir);
        if (!fs.existsSync(searchDir)) return false;
        const files = fs.readdirSync(searchDir);
        const regex = new RegExp('^' + base.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$');
        return files.some((f: string) => regex.test(f));
      } catch {
        return false;
      }

    case 'package_json_script':
      try {
        const pkgPath = path.join(targetDir, 'package.json');
        if (!fs.existsSync(pkgPath)) return false;
        const pkg: Record<string, unknown> = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const scripts = (pkg.scripts ?? {}) as Record<string, string>;
        return detection.script !== undefined && Boolean(scripts[detection.script]);
      } catch {
        return false;
      }

    case 'package_json_dep':
      try {
        const pkgPath = path.join(targetDir, 'package.json');
        if (!fs.existsSync(pkgPath)) return false;
        const pkg: Record<string, unknown> = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const deps = (pkg.dependencies ?? {}) as Record<string, string>;
        const devDeps = (pkg.devDependencies ?? {}) as Record<string, string>;
        const allDeps: Record<string, string> = { ...deps, ...devDeps };
        return (
          detection.dependency !== undefined &&
          Object.keys(allDeps).some((d) => d.includes(detection.dependency!))
        );
      } catch {
        return false;
      }

    default:
      return false;
  }
}

/**
 * Detect the first matching test runner from a list of runner configs.
 *
 * @param targetDir - Absolute path to the project directory
 * @param runners   - Array of runner configurations to check
 * @returns The matched runner config, or null if none matched
 */
export function detectTestRunner(targetDir: string, runners: RunnerConfig[]): RunnerConfig | null {
  for (const runner of runners) {
    const detections = runner.detection ?? [];
    const isDetected = detections.some((d) => checkDetection(d, targetDir));
    if (isDetected) return runner;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Test execution
// ---------------------------------------------------------------------------

/**
 * Execute a test command in the given directory.
 *
 * @param targetDir       - Directory in which to run the command
 * @param command         - Test command to execute
 * @param runnerName      - Name of the detected runner (for reporting)
 * @param executionConfig - Buffer and timeout settings
 * @returns Promise that resolves with the test run result
 */
export function runTests(
  targetDir: string,
  command: string,
  runnerName: string,
  executionConfig: ExecutionConfig = DEFAULT_CONFIG.execution
): Promise<TestRunResult> {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();

    exec(
      command,
      {
        cwd: targetDir,
        maxBuffer: executionConfig.max_buffer,
        timeout: executionConfig.timeout,
      },
      (error, stdout, stderr) => {
        const duration = parseFloat(((Date.now() - startTime) / 1000).toFixed(2));

        const result: TestRunResult = {
          targetDir: path.resolve(targetDir),
          runner: runnerName,
          command,
          duration,
          success: !error,
          exitCode: error ? ((error as NodeJS.ErrnoException).code as unknown as number) : 0,
          stdout,
          stderr: stderr || undefined,
        };

        if (error) {
          const err = Object.assign(
            new Error(`Test failed with exit code ${(error as NodeJS.ErrnoException).code}`),
            { data: result }
          );
          reject(err);
        } else {
          resolve(result);
        }
      }
    );
  });
}

/**
 * Build a SkillOutput envelope for the test-genie skill.
 *
 * @param result  - Test run result data
 * @param startMs - Start timestamp from Date.now()
 * @returns Standard SkillOutput envelope
 */
export function buildRunOutput(result: TestRunResult, startMs: number): SkillOutput<TestRunResult> {
  return {
    skill: 'test-genie',
    status: result.success ? 'success' : 'error',
    data: result,
    metadata: {
      duration_ms: Date.now() - startMs,
      timestamp: new Date().toISOString(),
    },
  };
}
