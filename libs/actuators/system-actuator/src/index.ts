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
  buildGovernedRetryOptions,
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
import {
  SYSTEM_ACTUATOR_CAPTURE_OPS,
  SYSTEM_ACTUATOR_APPLY_OPS,
  SYSTEM_ACTUATOR_TRANSFORM_OPS,
  SYSTEM_ACTUATOR_CONTROL_OPS,
} from './op-catalog.js';
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
export { describeOps } from './op-catalog.js';
export {
  SYSTEM_ACTUATOR_CAPTURE_OPS,
  SYSTEM_ACTUATOR_APPLY_OPS,
  SYSTEM_ACTUATOR_TRANSFORM_OPS,
  SYSTEM_ACTUATOR_CONTROL_OPS,
} from './op-catalog.js';

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

function buildRetryOptions(override?: Record<string, any>) {
  return buildGovernedRetryOptions({
    manifestPath: SYSTEM_MANIFEST_PATH,
    defaults: DEFAULT_SYSTEM_RETRY,
    override: override,
    fallbackCategories: ['network', 'rate_limit', 'timeout', 'resource_unavailable'],
  });
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
