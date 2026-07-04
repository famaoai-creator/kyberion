import {
  logger,
  safeReadFile,
  safeWriteFile,
  safeMkdir,
  safeExec,
  safeExecResult,
  safeExistsSync,
  derivePipelineStatus,
  emitComputerSurfacePatch,
  pathResolver,
  resolveVars,
  evaluateCondition,
  getPathValue,
  resolveWriteArtifactSpec,
  nativeTtsSpeak,
  probeNativeTts,
  classifyError,
  createVirtualMediaDeviceControlBridge,
  createVirtualDeviceInventoryBridge,
  createVirtualAudioOutputPlaybackBridge,
  createVirtualAudioInputRecordingBridge,
  createVirtualInputDeviceInventoryBridge,
  createVirtualCameraBridge,
  createVirtualCameraInjectionBridge,
  createScreenCaptureBridge,
  createScreenRecordingBridge,
  createScreenDisplayInventoryBridge,
  listToolRuntimeInventory,
  listServiceRuntimeInventory,
  type ScreenDisplayInventory,
  type ScreenDisplayRecord,
  StubVideoFrameBus,
  writeVideoFrameBusToMp4,
  pipeMp4ToVideoFrameBus,
} from '@agent/core';
import { randomUUID } from 'node:crypto';
import { getAllFiles } from '@agent/core/fs-utils';
import { createStandardYargs } from '@agent/core/cli-utils';
import {
  systemDisplayHelpers,
  type ResolvedScreenDisplaySelection,
} from './system-display-helpers.js';
import { systemFocusHelpers } from './system-focus-helpers.js';
import { executePipeline } from './system-pipeline-helpers.js';
import {
  handleSystemAction,
  type SystemAction,
  type ComputerInteractionAction,
  type SystemPipelineStep,
} from './system-action-helpers.js';
import {
  activateApplication,
  detectFocusedInput,
  keystrokeText,
  pasteText,
  pressKey,
  toggleDictation,
  clickAt,
  rightClickAt,
  moveMouse,
  scrollAt,
  dragFrom,
  activateWindowByTitle,
  getScreenSize,
  getWindowList,
  quitApplication,
  systemNotify,
  clipboardRead,
  clipboardWrite,
  listKnownAppCapabilities,
  listTerminalTargets,
  listChromeTabs,
  activateChromeTabByTitle,
  activateChromeTabByUrl,
  closeChromeTabByTitle,
  closeChromeTabByUrl,
  emptyFinderTrash,
  revealFinderPath,
  openFinderPath,
} from '@agent/core/os-automation';
import { osAutomationBridge } from '@agent/core/os-automation-bridge';
import { createApprovalRequest, loadApprovalRequest } from '@agent/core/governance';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as visionJudge from '@agent/shared-vision';
import { runActuatorCli } from '@agent/core';

/**
 * System-Actuator v2.1.0 [AUTONOMOUS CONTROL ENABLED]
 * Strictly compliant with Layer 2 (Shield).
 * Standardized with Control Flow (if/while) and Safety Guards.
 */
const ALLOW_UNSAFE_SHELL = process.env.KYBERION_ALLOW_UNSAFE_SHELL === 'true';
const ALLOW_UNSAFE_JS = process.env.KYBERION_ALLOW_UNSAFE_JS === 'true';
const COMPUTER_RUNTIME_DIR = pathResolver.shared('runtime/computer');
const FOCUS_TARGET_STORE_PATH = path.join(COMPUTER_RUNTIME_DIR, 'focused-targets.json');
const SYSTEM_MANIFEST_PATH = pathResolver.rootResolve(
  'libs/actuators/system-actuator/manifest.json'
);
const DEFAULT_SYSTEM_RETRY = {
  maxRetries: 2,
  initialDelayMs: 250,
  maxDelayMs: 2000,
  factor: 2,
  jitter: true,
};

let cachedRecoveryPolicy: Record<string, any> | undefined;

function assertUnsafeShellAllowed() {
  if (!ALLOW_UNSAFE_SHELL) {
    throw new Error(
      '[SECURITY] Shell execution disabled. Set KYBERION_ALLOW_UNSAFE_SHELL=true to enable.'
    );
  }
}

function assertUnsafeJsAllowed() {
  if (!ALLOW_UNSAFE_JS) {
    throw new Error(
      '[SECURITY] JS execution disabled. Set KYBERION_ALLOW_UNSAFE_JS=true to enable.'
    );
  }
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function loadRecoveryPolicy(): Record<string, any> {
  if (cachedRecoveryPolicy) return cachedRecoveryPolicy;
  try {
    const manifest = JSON.parse(safeReadFile(SYSTEM_MANIFEST_PATH, { encoding: 'utf8' }) as string);
    cachedRecoveryPolicy = isPlainObject(manifest?.recovery_policy) ? manifest.recovery_policy : {};
    return cachedRecoveryPolicy ?? {};
  } catch (_) {
    cachedRecoveryPolicy = {};
    return cachedRecoveryPolicy ?? {};
  }
}

function buildRetryOptions(override?: Record<string, any>) {
  const recoveryPolicy = loadRecoveryPolicy();
  const manifestRetry = isPlainObject(recoveryPolicy.retry) ? recoveryPolicy.retry : {};
  const retryableCategories = new Set<string>(
    Array.isArray(recoveryPolicy.retryable_categories)
      ? recoveryPolicy.retryable_categories.map(String)
      : []
  );
  const resolved = {
    ...DEFAULT_SYSTEM_RETRY,
    ...manifestRetry,
    ...(override || {}),
  };
  return {
    ...resolved,
    shouldRetry: (error: Error) => {
      const classification = classifyError(error);
      if (retryableCategories.size > 0) {
        return retryableCategories.has(classification.category);
      }
      return (
        classification.category === 'network' ||
        classification.category === 'rate_limit' ||
        classification.category === 'timeout' ||
        classification.category === 'resource_unavailable'
      );
    },
  };
}

function normalizeDisplayName(value: unknown): string | undefined {
  return systemDisplayHelpers.normalizeDisplayName(value);
}

function normalizeApplicationName(value: unknown): string | undefined {
  return systemDisplayHelpers.normalizeApplicationName(value);
}

function normalizeDisplayIndex(value: unknown): number | undefined {
  return systemDisplayHelpers.normalizeDisplayIndex(value);
}

function selectDisplayFromInventory(
  inventory: ScreenDisplayInventory,
  requestedIndex?: number,
  requestedName?: string
): {
  display: ScreenDisplayRecord;
  selection_source: 'explicit_index' | 'display_name' | 'primary' | 'fallback';
} {
  return systemDisplayHelpers.selectDisplayFromInventory(inventory, requestedIndex, requestedName);
}

async function resolveScreenDisplaySelection(
  params: Record<string, any>,
  resolve: (value: any) => any
): Promise<ResolvedScreenDisplaySelection> {
  return systemDisplayHelpers.resolveScreenDisplaySelection(params, resolve);
}

export const SYSTEM_ACTUATOR_CAPTURE_OPS = [
  'screenshot',
  'clipboard_read',
  'get_focused_input',
  'get_screen_size',
  'window_list',
  'chrome_tab_list',
  'read_file',
  'read_json',
  'probe',
  'glob_files',
  'scan_directory',
  'pulse_status',
  'exec',
  'shell',
  'cli_health_check',
  'list_missions',
  'list_projects',
  'list_capabilities',
  'list_incidents',
  'list_knowledge',
  'list_running_apps',
  'list_input_devices',
  'list_displays',
  'list_media_devices',
  'list_tool_runtimes',
  'list_service_runtimes',
  'control_media_devices',
  'collect_artifacts',
  'sample_traces',
  'vision_consult',
  'test_screen_stream',
  'test_screen_mp4_roundtrip',
  'test_camera_injection',
] as const;

export const SYSTEM_ACTUATOR_APPLY_OPS = [
  'scroll',
  'drag',
  'clipboard_write',
  'system_notify',
  'open_file',
  'app_quit',
  'process_kill',
  'run_applescript',
  'keyboard',
  'paste_text',
  'press_key',
  'voice_input_toggle',
  'mouse_click',
  'mouse_move',
  'activate_application',
  'open_url',
  'write_file',
  'write_artifact',
  'write_json',
  'mkdir',
  'log',
  'voice',
  'native_tts_speak',
  'check_native_tts',
  'notify',
  'wait',
] as const;

export const SYSTEM_ACTUATOR_TRANSFORM_OPS = [
  'regex_extract',
  'json_query',
  'sre_analyze',
  'run_js',
] as const;

export const SYSTEM_ACTUATOR_CONTROL_OPS = ['if', 'while'] as const;

const SYSTEM_ACTUATOR_CAPTURE_ALIAS_OPS = new Set<string>([...SYSTEM_ACTUATOR_CAPTURE_OPS, 'list']);

/**
 * Main Entry Point
 */
/**
 * Universal Pipeline Engine with Control Flow & Safety Guards
 * moved to system-pipeline-helpers.ts
 */

/**
 * CLI Runner
 */
const main = async () => {
  await runActuatorCli({
    name: 'system-actuator',
    handleAction: handleSystemAction,
  });
};

const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : '';
const modulePath = fileURLToPath(import.meta.url);

if (entrypoint && modulePath === entrypoint) {
  main().catch((err) => {
    logger.error(err.message);
    process.exit(1);
  });
}

export { handleSystemAction as handleAction };
