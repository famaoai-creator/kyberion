import * as path from 'node:path';
import {
  logger,
  missionDir,
  pathResolver,
  safeExecResult,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeReaddir,
  safeStat,
  safeWriteFile,
} from '@agent/core';

/**
 * E2E-05 Task 2/3: build-actuator core.
 *
 * Deviation note (documented in the plan's 実装状況): long-running builds use
 * safeExecResult with an op-level timeout override (default 45 min) instead of
 * terminal-actuator spawn/poll — same effect (no 10-min default ceiling),
 * deterministic and unit-testable.
 */

export type BuildOp =
  | 'scaffold_app'
  | 'ios_generate_project'
  | 'ios_build'
  | 'ios_test'
  | 'ios_archive'
  | 'android_build'
  | 'android_test'
  | 'android_bundle';

export interface BuildActuatorInput {
  op: BuildOp;
  project_dir?: string;
  scheme?: string;
  simulator?: string;
  connected?: boolean;
  platform?: 'ios' | 'android';
  app_name?: string;
  bundle_id?: string;
  dest_dir?: string;
  mission_id?: string;
  timeout_ms?: number;
}

export interface BuildActuatorResult {
  ok: boolean;
  op: BuildOp;
  duration_ms: number;
  log_path?: string;
  artifact_paths: string[];
  error_summary?: string[];
}

const DEFAULT_BUILD_TIMEOUT_MS = 45 * 60 * 1000;
const ERROR_SUMMARY_MAX_LINES = 10;

export function extractErrorSummary(logText: string): string[] {
  return logText
    .split('\n')
    .filter((line) => /(?:\berror\b|\bFAILED\b|\bBUILD FAILED\b|\*\* .*FAILED \*\*)/i.test(line))
    .slice(-ERROR_SUMMARY_MAX_LINES)
    .map((line) => line.trim());
}

function detectXcodeContainer(projectDir: string): string[] {
  try {
    const entries = safeReaddir(projectDir);
    const workspace = entries.find((entry) => entry.endsWith('.xcworkspace'));
    if (workspace) return ['-workspace', workspace];
    const project = entries.find((entry) => entry.endsWith('.xcodeproj'));
    if (project) return ['-project', project];
  } catch {
    // fall through — xcodebuild will fail with its own actionable error
  }
  return [];
}

function gradleCommand(projectDir: string): string {
  return safeExistsSync(path.join(projectDir, 'gradlew')) ? './gradlew' : 'gradle';
}

export function buildCommandForOp(input: BuildActuatorInput): {
  command: string;
  args: string[];
  cwd: string;
} {
  const projectDir = pathResolver.rootResolve(String(input.project_dir || '.'));
  switch (input.op) {
    case 'ios_generate_project':
      return { command: 'xcodegen', args: ['generate'], cwd: projectDir };
    case 'ios_build':
      return {
        command: 'xcodebuild',
        args: [
          ...detectXcodeContainer(projectDir),
          ...(input.scheme ? ['-scheme', input.scheme] : []),
          '-destination',
          'generic/platform=iOS Simulator',
          'build',
        ],
        cwd: projectDir,
      };
    case 'ios_test':
      return {
        command: 'xcodebuild',
        args: [
          'test',
          ...detectXcodeContainer(projectDir),
          ...(input.scheme ? ['-scheme', input.scheme] : []),
          '-destination',
          `platform=iOS Simulator,name=${input.simulator || 'iPhone 15'}`,
        ],
        cwd: projectDir,
      };
    case 'ios_archive':
      return {
        command: 'xcodebuild',
        args: [
          'archive',
          ...detectXcodeContainer(projectDir),
          ...(input.scheme ? ['-scheme', input.scheme] : []),
          // Signing stays off until the mobile-beta adapter (E2E-05 Task 6)
          // takes over with vault-referenced credentials.
          'CODE_SIGNING_ALLOWED=NO',
        ],
        cwd: projectDir,
      };
    case 'android_build':
      return { command: gradleCommand(projectDir), args: ['assembleDebug'], cwd: projectDir };
    case 'android_test':
      return {
        command: gradleCommand(projectDir),
        args: input.connected
          ? ['testDebugUnitTest', 'connectedDebugAndroidTest']
          : ['testDebugUnitTest'],
        cwd: projectDir,
      };
    case 'android_bundle':
      return { command: gradleCommand(projectDir), args: ['bundleRelease'], cwd: projectDir };
    default:
      throw new Error(`unsupported build op: ${input.op}`);
  }
}

function buildLogPath(op: BuildOp, missionId?: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  if (missionId) {
    const dir = path.join(missionDir(missionId, 'public'), 'evidence', 'build');
    safeMkdir(dir, { recursive: true });
    return path.join(dir, `${op}-${stamp}.log`);
  }
  const dir = pathResolver.rootResolve('active/shared/tmp/build-logs');
  safeMkdir(dir, { recursive: true });
  return path.join(dir, `${op}-${stamp}.log`);
}

function collectArtifacts(op: BuildOp, projectDir: string): string[] {
  const candidates: string[] = [];
  if (op === 'android_build') {
    candidates.push(path.join(projectDir, 'app/build/outputs/apk/debug/app-debug.apk'));
  }
  if (op === 'android_bundle') {
    candidates.push(path.join(projectDir, 'app/build/outputs/bundle/release/app-release.aab'));
  }
  return candidates.filter((candidate) => safeExistsSync(candidate));
}

function runBuildCommand(input: BuildActuatorInput): BuildActuatorResult {
  const { command, args, cwd } = buildCommandForOp(input);
  const startedAt = Date.now();
  const result = safeExecResult(command, args, {
    cwd,
    timeoutMs: input.timeout_ms || DEFAULT_BUILD_TIMEOUT_MS,
    maxOutputMB: 50,
  });
  const durationMs = Date.now() - startedAt;
  const logText = [
    `$ ${command} ${args.join(' ')}`,
    `cwd: ${cwd}`,
    `exit: ${result.status}`,
    '--- stdout ---',
    result.stdout,
    '--- stderr ---',
    result.stderr,
  ].join('\n');
  const logPath = buildLogPath(input.op, input.mission_id);
  safeWriteFile(logPath, logText);
  const ok = result.status === 0;
  return {
    ok,
    op: input.op,
    duration_ms: durationMs,
    log_path: logPath,
    artifact_paths: ok ? collectArtifacts(input.op, cwd) : [],
    ...(ok ? {} : { error_summary: extractErrorSummary(logText) }),
  };
}

// ---------------------------------------------------------------------------
// E2E-05 Task 3: app scaffolding from in-repo fixtures (no external tool).
// ---------------------------------------------------------------------------

const SCAFFOLD_SOURCES: Record<'ios' | 'android', string> = {
  ios: 'product/scaffolds/ios-swiftui-minimal',
  android: 'product/scaffolds/android-compose-minimal',
};

function copyScaffoldDir(
  sourceDir: string,
  destDir: string,
  replacements: Record<string, string>
): string[] {
  const written: string[] = [];
  safeMkdir(destDir, { recursive: true });
  for (const entry of safeReaddir(sourceDir)) {
    const sourcePath = path.join(sourceDir, entry);
    const destPath = path.join(destDir, entry);
    if (safeStat(sourcePath).isDirectory()) {
      written.push(...copyScaffoldDir(sourcePath, destPath, replacements));
      continue;
    }
    let content = String(safeReadFile(sourcePath, { encoding: 'utf8' }));
    for (const [placeholder, value] of Object.entries(replacements)) {
      content = content.split(placeholder).join(value);
    }
    safeWriteFile(destPath, content);
    written.push(destPath);
  }
  return written;
}

export function scaffoldApp(input: BuildActuatorInput): BuildActuatorResult {
  const startedAt = Date.now();
  const platform = input.platform;
  if (platform !== 'ios' && platform !== 'android') {
    throw new Error('scaffold_app requires platform: ios | android');
  }
  if (!input.app_name || !input.bundle_id || !input.dest_dir) {
    throw new Error('scaffold_app requires app_name, bundle_id and dest_dir');
  }
  const sourceDir = pathResolver.knowledge(SCAFFOLD_SOURCES[platform]);
  if (!safeExistsSync(sourceDir)) {
    throw new Error(`scaffold fixture missing: ${sourceDir}`);
  }
  const destDir = pathResolver.rootResolve(input.dest_dir);
  const written = copyScaffoldDir(sourceDir, destDir, {
    '{{APP_NAME}}': input.app_name,
    '{{BUNDLE_ID}}': input.bundle_id,
  });
  logger.info(
    `[build-actuator] scaffolded ${platform} app into ${destDir} (${written.length} files)`
  );
  return {
    ok: true,
    op: 'scaffold_app',
    duration_ms: Date.now() - startedAt,
    artifact_paths: written,
  };
}

export async function handleAction(rawInput: unknown): Promise<BuildActuatorResult> {
  const input = rawInput as BuildActuatorInput;
  if (!input || typeof input !== 'object' || !input.op) {
    throw new Error('build-actuator input requires an op');
  }
  if (input.op === 'scaffold_app') return scaffoldApp(input);
  if (!input.project_dir) {
    throw new Error(`${input.op} requires project_dir`);
  }
  return runBuildCommand(input);
}
