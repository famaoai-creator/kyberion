import { createHash, randomUUID } from 'node:crypto';
import { rootResolve } from './path-resolver.js';
import { resolveStorageFloor, SYSTEM_PARTITION } from './storage-layout.js';
import {
  safeExecResult,
  safeReadFile,
  safeWriteFile,
  safeLstat,
  safeMkdir,
  safeMoveSync,
  safeRmSync,
} from './secure-io.js';
import { withLockSync } from './foundation/lock-utils.js';
import type { FocusedInputState } from './apple-event-bridge.js';
import type { MouseOperation } from './virtual/os-automation-platform.js';

export type MacOSPermissionState = 'granted' | 'denied' | 'unsupported' | 'unknown';
export interface MacOSNativeAutomationAvailability {
  available: boolean;
  automation: MacOSPermissionState;
  browser_automation: MacOSPermissionState;
  accessibility: MacOSPermissionState;
  screen_recording: MacOSPermissionState;
  reason?: string;
}
const emptyInput = (): FocusedInputState => ({
  application: '',
  windowTitle: '',
  role: '',
  description: '',
  editable: false,
});
function regularExecutable(file: string): boolean {
  try {
    const stat = safeLstat(file);
    return stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}
let compilerVersion: string | undefined;
export function _resetMacOSNativeCompilerCacheForTests(): void {
  compilerVersion = undefined;
}
function ensureBinary(): string {
  const source = rootResolve('libs/core/macos-native-automation.swift');
  if (!compilerVersion) {
    const compiler = safeExecResult('/usr/bin/swiftc', ['--version'], {
      timeoutMs: 5000,
      maxOutputMB: 1,
    });
    if (compiler.error || compiler.status !== 0 || !compiler.stdout.includes('Swift version'))
      throw new Error('native_compiler_unavailable');
    compilerVersion = compiler.stdout;
  }
  const sourceBytes = safeReadFile(source);
  const digest = createHash('sha256')
    .update(sourceBytes)
    .update(process.platform)
    .update(process.arch)
    .update('bridge-v1')
    .update(compilerVersion)
    .digest('hex');
  const cache = resolveStorageFloor('cache', SYSTEM_PARTITION, 'macos-automation');
  const binary = resolveStorageFloor(
    'cache',
    SYSTEM_PARTITION,
    'macos-automation',
    'automation-' + digest
  );
  if (regularExecutable(binary)) return binary;
  return withLockSync(
    'macos-automation-build-' + digest,
    () => {
      if (regularExecutable(binary)) return binary;
      safeMkdir(cache, { recursive: true });
      const moduleCache = resolveStorageFloor(
        'cache',
        SYSTEM_PARTITION,
        'macos-automation',
        'module-cache'
      );
      safeMkdir(moduleCache, { recursive: true });
      const temp = binary + '.build-' + randomUUID();
      const snapshot = temp + '.swift';
      let snapshotCreated = false;
      let outputCreated = false;
      try {
        safeWriteFile(snapshot, sourceBytes, { createOnly: true, mode: 0o600 });
        snapshotCreated = true;
        safeWriteFile(temp, '', { createOnly: true, mode: 0o700 });
        outputCreated = true;
        const result = safeExecResult(
          '/usr/bin/swiftc',
          ['-O', '-module-cache-path', moduleCache, snapshot, '-o', temp],
          { timeoutMs: 120000, maxOutputMB: 1 }
        );
        if (result.error || result.status !== 0 || !regularExecutable(temp))
          throw new Error('native_compilation_failed');
        safeMoveSync(temp, binary);
        return binary;
      } finally {
        if (outputCreated) safeRmSync(temp, { force: true });
        if (snapshotCreated) safeRmSync(snapshot, { force: true });
      }
    },
    125000
  );
}
function run(
  command: 'probe' | 'mouse' | 'windows' | 'focused' | 'screen',
  payload: unknown = {}
): Record<string, unknown> {
  const result = safeExecResult(ensureBinary(), [command, JSON.stringify(payload)], {
    timeoutMs: 5000,
    maxOutputMB: 1,
  });
  if (result.error || result.status !== 0) throw new Error('native_execution_failed');
  const line = result.stdout.trim().split('\n').at(-1) || '';
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error('native_response_invalid');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('native_response_invalid');
  return parsed as Record<string, unknown>;
}
export function probeMacOSNativeAutomation(): MacOSNativeAutomationAvailability {
  if (process.platform !== 'darwin')
    return {
      available: false,
      automation: 'unsupported',
      browser_automation: 'unsupported',
      accessibility: 'unsupported',
      screen_recording: 'unsupported',
      reason: 'macos_only_capability',
    };
  try {
    const value = run('probe');
    if (
      ['automation', 'browser_automation', 'accessibility', 'screen_recording'].some(
        (key) =>
          typeof value[key] !== 'string' ||
          !['granted', 'denied', 'unsupported', 'unknown'].includes(value[key] as string)
      )
    )
      throw new Error('native_response_invalid');
    return {
      available: true,
      automation: value.automation as MacOSPermissionState,
      browser_automation: value.browser_automation as MacOSPermissionState,
      accessibility: value.accessibility as MacOSPermissionState,
      screen_recording: value.screen_recording as MacOSPermissionState,
    };
  } catch (error) {
    const known = [
      'native_compiler_unavailable',
      'native_compilation_failed',
      'native_execution_failed',
      'native_response_invalid',
    ];
    const reason =
      error instanceof Error && known.includes(error.message)
        ? error.message
        : 'native_probe_failed';
    return {
      available: false,
      automation: 'unknown',
      browser_automation: 'unknown',
      accessibility: 'unknown',
      screen_recording: 'unknown',
      reason,
    };
  }
}
function coordinate(value: number): void {
  if (!Number.isFinite(value) || Math.abs(value) > 100000)
    throw new Error('invalid_mouse_coordinate');
}
function positive(value: number, maximum: number): void {
  if (!Number.isInteger(value) || value < 1 || value > maximum)
    throw new Error('invalid_mouse_amount');
}
export function performMacOSMouseOperation(operation: MouseOperation): void {
  switch (operation.type) {
    case 'move':
      coordinate(operation.x);
      coordinate(operation.y);
      break;
    case 'click':
      coordinate(operation.x);
      coordinate(operation.y);
      positive(operation.count ?? 1, 10);
      if (operation.button !== undefined && !['left', 'right'].includes(operation.button))
        throw new Error('invalid_mouse_button');
      break;
    case 'scroll':
      coordinate(operation.x);
      coordinate(operation.y);
      positive(operation.amount ?? 3, 1000);
      if (!['up', 'down', 'left', 'right'].includes(operation.direction))
        throw new Error('invalid_scroll_direction');
      break;
    case 'drag':
      coordinate(operation.fromX);
      coordinate(operation.fromY);
      coordinate(operation.toX);
      coordinate(operation.toY);
      break;
    default:
      throw new Error('invalid_mouse_operation');
  }
  if (process.platform !== 'darwin') return;
  const permission = probeMacOSNativeAutomation();
  if (permission.accessibility !== 'granted')
    throw new Error(
      permission.accessibility === 'denied'
        ? 'macos_accessibility_denied'
        : 'macos_accessibility_unavailable'
    );
  try {
    if (run('mouse', operation).ok !== true) throw new Error('native_mouse_failed');
  } catch {
    throw new Error('native_mouse_failed');
  }
}
export function listMacOSAXWindows(appName: string): string[] {
  if (
    process.platform !== 'darwin' ||
    !appName.trim() ||
    appName.length > 256 ||
    appName.includes('\0')
  )
    return [];
  try {
    const value = run('windows', { application: appName }).windows;
    if (
      !Array.isArray(value) ||
      value.length > 1000 ||
      !value.every((entry) => typeof entry === 'string')
    )
      throw new Error('native_response_invalid');
    return value;
  } catch {
    throw new Error('macos_windows_unavailable');
  }
}
export function getMacOSFocusedInput(): FocusedInputState {
  if (process.platform !== 'darwin') return emptyInput();
  try {
    const value = run('focused');
    if (
      ['application', 'windowTitle', 'role', 'description'].some(
        (key) => typeof value[key] !== 'string'
      ) ||
      typeof value.editable !== 'boolean'
    )
      throw new Error('native_response_invalid');
    return {
      application: value.application as string,
      windowTitle: value.windowTitle as string,
      role: value.role as string,
      description: value.description as string,
      editable: value.editable,
    };
  } catch {
    throw new Error('macos_focused_input_unavailable');
  }
}
export function getMacOSScreenSize(): { width: number; height: number } {
  if (process.platform !== 'darwin') return { width: 0, height: 0 };
  try {
    const value = run('screen');
    if (
      typeof value.width === 'number' &&
      typeof value.height === 'number' &&
      Number.isFinite(value.width) &&
      Number.isFinite(value.height) &&
      value.width > 0 &&
      value.height > 0
    )
      return { width: value.width, height: value.height };
  } catch {
    /* optional capability */
  }
  return { width: 0, height: 0 };
}
