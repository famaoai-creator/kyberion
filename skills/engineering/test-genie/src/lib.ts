import { exec } from 'node:child_process';
import * as path from 'node:path';
import { safeReadFile, getAllFiles } from '@agent/core';

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

/**
 * Check detection rules using Secure-IO compliant methods.
 */
export function checkDetection(detection: DetectionRule, targetDir: string): boolean {
  switch (detection.type) {
    case 'file_exists': {
      if (!detection.path) return false;
      const fullPath = path.join(targetDir, detection.path);
      try {
        safeReadFile(fullPath, { maxSizeMB: 0.1 }); // Fast check
        return true;
      } catch (_) {
        return false;
      }
    }

    case 'directory_exists': {
      if (!detection.path) return false;
      const dirPath = path.join(targetDir, detection.path);
      try {
        // Use getAllFiles with shallow depth to verify directory
        const files = getAllFiles(dirPath);
        return files !== undefined;
      } catch (_) {
        return false;
      }
    }

    case 'file_pattern':
      if (!detection.pattern) return false;
      try {
        const dir = path.dirname(detection.pattern);
        const base = path.basename(detection.pattern);
        const searchDir = path.join(targetDir, dir === '.' ? '' : dir);
        const files = getAllFiles(searchDir).map(f => path.basename(f));
        const regex = new RegExp('^' + base.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$');
        return files.some((f: string) => regex.test(f));
      } catch {
        return false;
      }

    case 'package_json_script':
      try {
        const pkgPath = path.join(targetDir, 'package.json');
        const pkg: any = JSON.parse(safeReadFile(pkgPath, { encoding: 'utf8' }) as string);
        const scripts = (pkg.scripts ?? {}) as Record<string, string>;
        return detection.script !== undefined && Boolean(scripts[detection.script]);
      } catch {
        return false;
      }

    case 'package_json_dep':
      try {
        const pkgPath = path.join(targetDir, 'package.json');
        const pkg: any = JSON.parse(safeReadFile(pkgPath, { encoding: 'utf8' }) as string);
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
  return new Promise((resolve) => {
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
          exitCode: error ? (error as any).code : 0,
          stdout,
          stderr: stderr || undefined,
        };

        resolve(result);
      }
    );
  });
}
