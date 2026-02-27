import { exec } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { safeExec } from '@agent/core/secure-io'; // Use safeExec instead of exec if possible, but safeExec is sync. safeSpawn or exec is fine.

// Types
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

export interface RunnerConfig {
  name: string;
  detection: DetectionRule[];
  command: string;
}

export interface ExecutionConfig {
  max_buffer: number;
  timeout: number;
}

export interface TestGenieConfig {
  runners: RunnerConfig[];
  execution: ExecutionConfig;
}

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
      if (!detection.pattern) return false;
      try {
        // Simple fs-based fallback for glob
        const dir = path.dirname(detection.pattern);
        const base = path.basename(detection.pattern);
        const searchDir = path.join(targetDir, dir === '.' ? '' : dir);
        if (!fs.existsSync(searchDir)) return false;
        const files = fs.readdirSync(searchDir);
        const regex = new RegExp('^' + base.replace(/\./g, '\.').replace(/\*/g, '.*') + '$');
        return files.some((f: string) => regex.test(f));
      } catch {
        return false;
      }

    case 'package_json_script':
      try {
        const pkgPath = path.join(targetDir, 'package.json');
        if (!fs.existsSync(pkgPath)) return false;
        const pkg: Record<string, unknown> = JSON.parse(safeReadFile(pkgPath, 'utf8'));
        const scripts = (pkg.scripts ?? {}) as Record<string, string>;
        return detection.script !== undefined && Boolean(scripts[detection.script]);
      } catch {
        return false;
      }

    case 'package_json_dep':
      try {
        const pkgPath = path.join(targetDir, 'package.json');
        if (!fs.existsSync(pkgPath)) return false;
        const pkg: Record<string, unknown> = JSON.parse(safeReadFile(pkgPath, 'utf8'));
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

export function detectTestRunner(targetDir: string, runners: RunnerConfig[]): RunnerConfig | null {
  for (const runner of runners) {
    const detections = runner.detection ?? [];
    const isDetected = detections.some((d) => checkDetection(d, targetDir));
    if (isDetected) return runner;
  }
  return null;
}

export function runTests(
  targetDir: string,
  command: string,
  runnerName: string,
  executionConfig: ExecutionConfig = DEFAULT_CONFIG.execution
): Promise<TestRunResult> {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();

    // Note: exec is used here because we want to capture stdout/stderr buffer.
    // safeExec in libs/core returns stdout string but doesn't easily separate stderr or handle exit codes cleanly for this use case.
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
          // We resolve with result even on error, because test failures are expected outcomes.
          // Rejection is for execution failures (spawn failed etc), but here exec calls callback with error on non-zero exit code too.
          // The original logic rejected, let's keep it consistent but attach data.
          const err = Object.assign(
            new Error(`Test failed with exit code ${(error as NodeJS.ErrnoException).code}`),
            { data: result }
          );
          resolve(result); // Actually, typically we want to return the result object even if tests failed.
        } else {
          resolve(result);
        }
      }
    );
  });
}
