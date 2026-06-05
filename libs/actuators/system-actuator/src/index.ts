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
  withRetry,
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
import { systemDisplayHelpers, type ResolvedScreenDisplaySelection } from './system-display-helpers.js';
import { systemFocusHelpers } from './system-focus-helpers.js';
import { executePipeline } from './system-pipeline-helpers.js';
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
  type FocusedInputState,
} from '@agent/core/os-automation';
import { osAutomationBridge } from '@agent/core/os-automation-bridge';
import { createApprovalRequest, loadApprovalRequest } from '@agent/core/governance';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as visionJudge from '@agent/shared-vision';

/**
 * System-Actuator v2.1.0 [AUTONOMOUS CONTROL ENABLED]
 * Strictly compliant with Layer 2 (Shield).
 * Standardized with Control Flow (if/while) and Safety Guards.
 */
const ALLOW_UNSAFE_SHELL = process.env.KYBERION_ALLOW_UNSAFE_SHELL === 'true';
const ALLOW_UNSAFE_JS = process.env.KYBERION_ALLOW_UNSAFE_JS === 'true';
const COMPUTER_RUNTIME_DIR = pathResolver.shared('runtime/computer');
const FOCUS_TARGET_STORE_PATH = path.join(COMPUTER_RUNTIME_DIR, 'focused-targets.json');
const SYSTEM_MANIFEST_PATH = pathResolver.rootResolve('libs/actuators/system-actuator/manifest.json');
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
    throw new Error('[SECURITY] Shell execution disabled. Set KYBERION_ALLOW_UNSAFE_SHELL=true to enable.');
  }
}

function assertUnsafeJsAllowed() {
  if (!ALLOW_UNSAFE_JS) {
    throw new Error('[SECURITY] JS execution disabled. Set KYBERION_ALLOW_UNSAFE_JS=true to enable.');
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
    Array.isArray(recoveryPolicy.retryable_categories) ? recoveryPolicy.retryable_categories.map(String) : [],
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
      return classification.category === 'network'
        || classification.category === 'rate_limit'
        || classification.category === 'timeout'
        || classification.category === 'resource_unavailable';
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
  requestedName?: string,
): { display: ScreenDisplayRecord; selection_source: 'explicit_index' | 'display_name' | 'primary' | 'fallback' } {
  return systemDisplayHelpers.selectDisplayFromInventory(inventory, requestedIndex, requestedName);
}

async function resolveScreenDisplaySelection(params: Record<string, any>, resolve: (value: any) => any): Promise<ResolvedScreenDisplaySelection> {
  return systemDisplayHelpers.resolveScreenDisplaySelection(params, resolve);
}

interface PipelineStep {
  type: 'capture' | 'transform' | 'apply' | 'control';
  op: string;
  params: any;
}

interface SystemAction {
  action: 'pipeline' | 'reconcile';
  steps?: PipelineStep[];
  strategy_path?: string;
  context?: Record<string, any>;
  options?: {
    max_steps?: number;
    timeout_ms?: number;
  };
}

interface ComputerInteractionAction {
  version: '0.1';
  kind: 'computer_interaction';
  session_id?: string;
  target?: {
    executor?: 'browser' | 'terminal' | 'system';
    display_id?: string;
    application?: string;
    focus_target_id?: string;
    focus_target_match_policy?: 'strict' | 'prefix' | 'contains';
  };
  action: {
    type:
      | 'left_click'
      | 'double_click'
      | 'right_click'
      | 'mouse_move'
      | 'activate_application'
      | 'detect_focused_input'
      | 'remember_focused_target'
      | 'type_into_focused_input'
      | 'submit_focused_input'
      | 'list_known_app_capabilities'
      | 'list_terminal_targets'
      | 'list_tabs'
      | 'activate_tab_by_title'
      | 'activate_tab_by_url'
      | 'close_tab_by_title'
      | 'close_tab_by_url'
      | 'reveal_path'
      | 'open_path'
      | 'empty_trash'
      | 'type'
      | 'key'
      | 'voice_input_toggle'
      | 'wait';
    coordinate?: { x: number; y: number };
    text?: string;
    key?: string;
    dictation_keycode?: number;
    path?: string;
    url?: string;
    application?: string;
    title?: string;
    approval_request_id?: string;
    focus_target_id?: string;
    input_strategy?: 'keystroke' | 'paste';
    timeout_ms?: number;
  };
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

export const SYSTEM_ACTUATOR_CONTROL_OPS = [
  'if',
  'while',
] as const;

const SYSTEM_ACTUATOR_CAPTURE_ALIAS_OPS = new Set<string>([
  ...SYSTEM_ACTUATOR_CAPTURE_OPS,
  'list',
]);

/**
 * Main Entry Point
 */
async function handleAction(input: SystemAction) {
  if ((input as any).kind === 'computer_interaction') {
    return await handleComputerInteraction(input as unknown as ComputerInteractionAction);
  }
  if (input.action === 'reconcile') {
    return await performReconcile(input);
  }
  return await executePipeline(input.steps || [], input.context || {}, input.options);
}

async function handleComputerInteraction(input: ComputerInteractionAction) {
  const interaction = input.action;
  const focusTargetId = interaction.focus_target_id || input.target?.focus_target_id;
  const focusTargetMatchPolicy = input.target?.focus_target_match_policy || 'strict';
  const rememberedTarget = loadRememberedFocusTarget(focusTargetId);
  const application = interaction.application || input.target?.application || rememberedTarget?.application;
  const sessionId = input.session_id || 'computer-system';

  const emitPatch = (
    status: string,
    latestAction: string,
    detail?: string,
    target?: string,
    metadata?: Record<string, unknown>,
  ) => {
    emitComputerSurfacePatch({
      sessionId,
      executor: 'system',
      status,
      latestAction,
      target,
      detail,
      metadata,
    });
  };

  if (interaction.type === 'detect_focused_input') {
    if (application) {
      activateApplication(application);
    }
    const focusedInput = detectFocusedInput();
    return {
      status: 'succeeded',
      results: [{ op: 'detect_focused_input', status: 'success' }],
      context: { focused_input: focusedInput },
      total_steps: 1,
    };
  }

  if (interaction.type === 'remember_focused_target') {
    if (application) {
      activateApplication(application);
    }
    const focusedInput = detectFocusedInput();
    const targetId = rememberFocusedTarget(interaction.focus_target_id || input.target?.focus_target_id, focusedInput);
    return {
      status: 'succeeded',
      results: [{ op: 'remember_focused_target', status: 'success' }],
      context: {
        focus_target_id: targetId,
        focused_input: focusedInput,
      },
      total_steps: 1,
    };
  }

  if (interaction.type === 'type_into_focused_input') {
    if (application) {
      activateApplication(application);
    }
    const focusedInput = detectFocusedInputWithGuard(rememberedTarget, focusTargetId, focusTargetMatchPolicy);
    if (!focusedInput.editable) {
      throw new Error(`Focused element is not editable (${focusedInput.role || 'unknown'})`);
    }
    return executePipeline(
      [{
        type: 'apply',
        op: interaction.input_strategy === 'keystroke' ? 'keyboard' : 'paste_text',
        params: { text: interaction.text || '' },
      }],
      { focused_input: focusedInput },
      { timeout_ms: interaction.timeout_ms || 60000 },
    );
  }

  if (interaction.type === 'submit_focused_input') {
    if (application) {
      activateApplication(application);
    }
    const focusedInput = detectFocusedInputWithGuard(rememberedTarget, focusTargetId, focusTargetMatchPolicy);
    if (!focusedInput.editable) {
      throw new Error(`Focused element is not editable (${focusedInput.role || 'unknown'})`);
    }
    return executePipeline(
      [{ type: 'apply', op: 'press_key', params: { key: 'enter' } }],
      { focused_input: focusedInput },
      { timeout_ms: interaction.timeout_ms || 60000 },
    );
  }

  if (interaction.type === 'list_known_app_capabilities') {
    const capabilities = listKnownAppCapabilities();
    emitPatch('succeeded', interaction.type, 'known app capability listing', undefined, {
      capabilityCount: capabilities.length,
    });
    return {
      status: 'succeeded',
      results: [{ op: 'list_known_app_capabilities', status: 'success' }],
      context: {
        known_app_capabilities: capabilities,
      },
      total_steps: 1,
    };
  }

  if (interaction.type === 'list_terminal_targets') {
    const terminalTargets = listTerminalTargets();
    emitPatch('succeeded', interaction.type, 'terminal target listing', undefined, {
      targetCount: terminalTargets.length,
      targets: terminalTargets.map((target) => ({
        application: target.application,
        preferred: target.preferred,
        sessionCount: target.sessionCount,
        canInject: target.canInject,
      })),
    });
    return {
      status: 'succeeded',
      results: [{ op: 'list_terminal_targets', status: 'success' }],
      context: {
        terminal_targets: terminalTargets,
      },
      total_steps: 1,
    };
  }

  if (interaction.type === 'list_tabs') {
    const tabs = listChromeTabs(application || 'Google Chrome');
    emitPatch('succeeded', interaction.type, `${tabs.length} tabs`, application || 'Google Chrome', {
      tabCount: tabs.length,
    });
    return {
      status: 'succeeded',
      results: [{ op: 'list_tabs', status: 'success' }],
      context: {
        browser_tabs: tabs,
      },
      total_steps: 1,
    };
  }

  if (interaction.type === 'activate_tab_by_title') {
    const result = activateChromeTabByTitle(interaction.title || '', application || 'Google Chrome');
    emitPatch(result.matched ? 'succeeded' : 'failed', interaction.type, interaction.title || '', application || 'Google Chrome', {
      title: interaction.title || '',
      matched: result.matched,
    });
    return {
      status: result.matched ? 'succeeded' : 'failed',
      results: [{ op: 'activate_tab_by_title', status: result.matched ? 'success' : 'failed' }],
      context: {
        tab_activation: {
          application: application || 'Google Chrome',
          title: interaction.title || '',
          matched: result.matched,
        },
      },
      total_steps: 1,
    };
  }

  if (interaction.type === 'activate_tab_by_url') {
    const result = activateChromeTabByUrl(interaction.url || interaction.title || '', application || 'Google Chrome');
    emitPatch(result.matched ? 'succeeded' : 'failed', interaction.type, interaction.url || interaction.title || '', application || 'Google Chrome', {
      url: interaction.url || interaction.title || '',
      matched: result.matched,
    });
    return {
      status: result.matched ? 'succeeded' : 'failed',
      results: [{ op: 'activate_tab_by_url', status: result.matched ? 'success' : 'failed' }],
      context: {
        tab_activation: {
          application: application || 'Google Chrome',
          url: interaction.url || interaction.title || '',
          matched: result.matched,
        },
      },
      total_steps: 1,
    };
  }

  if (interaction.type === 'close_tab_by_title') {
    const approvalRequestId = interaction.approval_request_id;
    if (!approvalRequestId) {
      const request = createApprovalRequest('sovereign_concierge', {
        channel: 'computer',
        storageChannel: 'computer',
        threadTs: input.session_id || 'computer',
        correlationId: randomUUID(),
        requestedBy: 'system-actuator',
        kind: 'channel-approval',
        draft: {
          title: 'Approval required: close Chrome tab',
          summary: 'A computer interaction requested a destructive browser tab close operation.',
          details: 'Approve this request before running close_tab_by_title.',
          severity: 'medium',
        },
        requestedByContext: {
          surface: 'system',
          actorId: 'system-actuator',
          actorRole: 'sovereign_concierge',
          runtimeId: input.session_id,
        },
        justification: {
          reason: 'Potentially destructive desktop operation requested through computer_interaction.',
          impactSummary: 'The first matching Chrome tab will be closed.',
          requestedEffects: ['close_chrome_tab'],
        },
        risk: {
          level: 'medium',
          restartScope: 'none',
          requiresStrongAuth: false,
          policyId: 'wf_computer_destructive_v1',
        },
        workflow: {
          workflowId: 'wf_computer_destructive_v1',
          mode: 'all_required',
          requiredRoles: ['sovereign'],
          currentStage: 'review',
          stages: [
            {
              stageId: 'review',
              requiredRoles: ['sovereign'],
              description: 'Approve destructive computer action',
            },
          ],
          approvals: [
            {
              role: 'sovereign',
              status: 'pending',
            },
          ],
        },
      });
      emitPatch('blocked', interaction.type, 'approval required', application || 'Google Chrome', {
        title: interaction.title || '',
        approvalRequired: true,
      });
      return {
        status: 'blocked',
        results: [{ op: 'close_tab_by_title', status: 'blocked' }],
        context: {
          approval_required: true,
          approval_request_id: request.id,
          approval_channel: 'computer',
        },
        total_steps: 1,
      };
    }

    const request = loadApprovalRequest('computer', approvalRequestId);
    if (!request || (request.status !== 'approved' && request.status !== 'applied')) {
      emitPatch('blocked', interaction.type, 'approval required', application || 'Google Chrome', {
        title: interaction.title || '',
        approvalRequired: true,
      });
      return {
        status: 'blocked',
        results: [{ op: 'close_tab_by_title', status: 'blocked' }],
        context: {
          approval_required: true,
          approval_request_id: approvalRequestId,
          approval_channel: 'computer',
        },
        total_steps: 1,
      };
    }

    const result = closeChromeTabByTitle(interaction.title || '', application || 'Google Chrome');
    emitPatch(result.matched ? 'succeeded' : 'failed', interaction.type, interaction.title || '', application || 'Google Chrome', {
      title: interaction.title || '',
      matched: result.matched,
    });
    return {
      status: result.matched ? 'succeeded' : 'failed',
      results: [{ op: 'close_tab_by_title', status: result.matched ? 'success' : 'failed' }],
      context: {
        tab_close: {
          application: application || 'Google Chrome',
          title: interaction.title || '',
          matched: result.matched,
        },
      },
      total_steps: 1,
    };
  }

  if (interaction.type === 'close_tab_by_url') {
    const approvalRequestId = interaction.approval_request_id;
    if (!approvalRequestId) {
      const request = createApprovalRequest('sovereign_concierge', {
        channel: 'computer',
        storageChannel: 'computer',
        threadTs: sessionId,
        correlationId: randomUUID(),
        requestedBy: 'system-actuator',
        kind: 'channel-approval',
        draft: {
          title: 'Approval required: close Chrome tab by URL',
          summary: 'A computer interaction requested a destructive browser tab close operation.',
          details: 'Approve this request before running close_tab_by_url.',
          severity: 'medium',
        },
        requestedByContext: {
          surface: 'system',
          actorId: 'system-actuator',
          actorRole: 'sovereign_concierge',
          runtimeId: sessionId,
        },
        justification: {
          reason: 'Potentially destructive desktop operation requested through computer_interaction.',
          impactSummary: 'The first matching Chrome tab URL will be closed.',
          requestedEffects: ['close_chrome_tab'],
        },
        risk: {
          level: 'medium',
          restartScope: 'none',
          requiresStrongAuth: false,
          policyId: 'wf_computer_destructive_v1',
        },
        workflow: {
          workflowId: 'wf_computer_destructive_v1',
          mode: 'all_required',
          requiredRoles: ['sovereign'],
          currentStage: 'review',
          stages: [
            {
              stageId: 'review',
              requiredRoles: ['sovereign'],
              description: 'Approve destructive computer action',
            },
          ],
          approvals: [
            {
              role: 'sovereign',
              status: 'pending',
            },
          ],
        },
      });
      emitPatch('blocked', interaction.type, 'approval required', application || 'Google Chrome', {
        url: interaction.url || interaction.title || '',
        approvalRequired: true,
      });
      return {
        status: 'blocked',
        results: [{ op: 'close_tab_by_url', status: 'blocked' }],
        context: {
          approval_required: true,
          approval_request_id: request.id,
          approval_channel: 'computer',
        },
        total_steps: 1,
      };
    }

    const request = loadApprovalRequest('computer', approvalRequestId);
    if (!request || (request.status !== 'approved' && request.status !== 'applied')) {
      emitPatch('blocked', interaction.type, 'approval required', application || 'Google Chrome', {
        url: interaction.url || interaction.title || '',
        approvalRequired: true,
      });
      return {
        status: 'blocked',
        results: [{ op: 'close_tab_by_url', status: 'blocked' }],
        context: {
          approval_required: true,
          approval_request_id: approvalRequestId,
          approval_channel: 'computer',
        },
        total_steps: 1,
      };
    }

    const result = closeChromeTabByUrl(interaction.url || interaction.title || '', application || 'Google Chrome');
    emitPatch(result.matched ? 'succeeded' : 'failed', interaction.type, interaction.url || interaction.title || '', application || 'Google Chrome', {
      url: interaction.url || interaction.title || '',
      matched: result.matched,
    });
    return {
      status: result.matched ? 'succeeded' : 'failed',
      results: [{ op: 'close_tab_by_url', status: result.matched ? 'success' : 'failed' }],
      context: {
        tab_close: {
          application: application || 'Google Chrome',
          url: interaction.url || interaction.title || '',
          matched: result.matched,
        },
      },
      total_steps: 1,
    };
  }

  if (interaction.type === 'reveal_path') {
    const targetPath = interaction.path || interaction.text || '';
    if (!targetPath) {
      throw new Error('Path is required for reveal_path');
    }
    revealFinderPath(targetPath);
    emitPatch('succeeded', interaction.type, targetPath, 'Finder', { path: targetPath });
    return {
      status: 'succeeded',
      results: [{ op: 'reveal_path', status: 'success' }],
      context: {
        file_manager_action: {
          application: 'Finder',
          action: 'reveal_path',
          path: targetPath,
        },
      },
      total_steps: 1,
    };
  }

  if (interaction.type === 'open_path') {
    const targetPath = interaction.path || interaction.text || '';
    if (!targetPath) {
      throw new Error('Path is required for open_path');
    }
    openFinderPath(targetPath);
    emitPatch('succeeded', interaction.type, targetPath, 'Finder', { path: targetPath });
    return {
      status: 'succeeded',
      results: [{ op: 'open_path', status: 'success' }],
      context: {
        file_manager_action: {
          application: 'Finder',
          action: 'open_path',
          path: targetPath,
        },
      },
      total_steps: 1,
    };
  }

  if (interaction.type === 'empty_trash') {
    const approvalRequestId = interaction.approval_request_id;
    if (!approvalRequestId) {
      const request = createApprovalRequest('sovereign_concierge', {
        channel: 'computer',
        storageChannel: 'computer',
        threadTs: input.session_id || 'computer',
        correlationId: randomUUID(),
        requestedBy: 'system-actuator',
        kind: 'channel-approval',
        draft: {
          title: 'Approval required: empty Finder trash',
          summary: 'A computer interaction requested a destructive Finder operation.',
          details: 'Approve this request before running empty_trash.',
          severity: 'high',
        },
        requestedByContext: {
          surface: 'system',
          actorId: 'system-actuator',
          actorRole: 'sovereign_concierge',
          runtimeId: input.session_id,
        },
        justification: {
          reason: 'Destructive desktop operation requested through computer_interaction.',
          impactSummary: 'All items currently in Finder trash will be permanently removed.',
          requestedEffects: ['empty_finder_trash'],
        },
        risk: {
          level: 'high',
          restartScope: 'none',
          requiresStrongAuth: false,
          policyId: 'wf_computer_destructive_v1',
        },
        workflow: {
          workflowId: 'wf_computer_destructive_v1',
          mode: 'all_required',
          requiredRoles: ['sovereign'],
          currentStage: 'review',
          stages: [
            {
              stageId: 'review',
              requiredRoles: ['sovereign'],
              description: 'Approve destructive computer action',
            },
          ],
          approvals: [
            {
              role: 'sovereign',
              status: 'pending',
            },
          ],
        },
      });
      emitPatch('blocked', interaction.type, 'approval required', 'Finder', {
        approvalRequired: true,
      });
      return {
        status: 'blocked',
        results: [{ op: 'empty_trash', status: 'blocked' }],
        context: {
          approval_required: true,
          approval_request_id: request.id,
          approval_channel: 'computer',
        },
        total_steps: 1,
      };
    }

    const request = loadApprovalRequest('computer', approvalRequestId);
    if (!request || (request.status !== 'approved' && request.status !== 'applied')) {
      emitPatch('blocked', interaction.type, 'approval required', 'Finder', {
        approvalRequired: true,
      });
      return {
        status: 'blocked',
        results: [{ op: 'empty_trash', status: 'blocked' }],
        context: {
          approval_required: true,
          approval_request_id: approvalRequestId,
          approval_channel: 'computer',
        },
        total_steps: 1,
      };
    }

    emptyFinderTrash();
    emitPatch('succeeded', interaction.type, 'trash emptied', 'Finder', {
      destructive: true,
    });
    return {
      status: 'succeeded',
      results: [{ op: 'empty_trash', status: 'success' }],
      context: {
        file_manager_action: {
          application: 'Finder',
          action: 'empty_trash',
        },
      },
      total_steps: 1,
    };
  }

  const steps: PipelineStep[] = [];
  if (application && interaction.type !== 'wait' && interaction.type !== 'activate_application') {
    steps.push({
      type: 'apply',
      op: 'activate_application',
      params: { application },
    });
  }

  switch (interaction.type) {
    case 'activate_application':
      steps.push({
        type: 'apply',
        op: 'activate_application',
        params: { application: application || '' },
      });
      break;
    case 'type':
      steps.push({ type: 'apply', op: 'keyboard', params: { text: interaction.text || '' } });
      break;
    case 'key':
      steps.push({ type: 'apply', op: 'keyboard', params: { text: interaction.key || '' } });
      break;
    case 'voice_input_toggle':
      steps.push({
        type: 'apply',
        op: 'voice_input_toggle',
        params: { dictation_keycode: interaction.dictation_keycode ?? 176 },
      });
      break;
    case 'left_click':
      steps.push({
        type: 'apply',
        op: 'mouse_click',
        params: {
          x: interaction.coordinate?.x || 0,
          y: interaction.coordinate?.y || 0,
          button: 'left',
        },
      });
      break;
    case 'double_click':
      steps.push({
        type: 'apply',
        op: 'mouse_click',
        params: {
          x: interaction.coordinate?.x || 0,
          y: interaction.coordinate?.y || 0,
          button: 'left',
          click_count: 2,
        },
      });
      break;
    case 'right_click':
      steps.push({
        type: 'apply',
        op: 'mouse_click',
        params: {
          x: interaction.coordinate?.x || 0,
          y: interaction.coordinate?.y || 0,
          button: 'right',
        },
      });
      break;
    case 'mouse_move':
      steps.push({
        type: 'apply',
        op: 'mouse_move',
        params: {
          x: interaction.coordinate?.x || 0,
          y: interaction.coordinate?.y || 0,
        },
      });
      break;
    case 'wait':
      steps.push({
        type: 'apply',
        op: 'wait',
        params: {
          duration_ms: interaction.timeout_ms || 1000,
        },
      });
      break;
    default:
      throw new Error(`Unsupported computer interaction action for system-actuator: ${interaction.type}`);
  }

  return executePipeline(steps, {}, { timeout_ms: interaction.timeout_ms || 60000 });
}

function loadFocusTargetStore(): Record<string, any> {
  return systemFocusHelpers.loadFocusTargetStore();
}

function saveFocusTargetStore(store: Record<string, any>) {
  systemFocusHelpers.saveFocusTargetStore(store);
}

function rememberFocusedTarget(explicitId: string | undefined, focusedInput: FocusedInputState) {
  return systemFocusHelpers.rememberFocusedTarget(explicitId, focusedInput);
}

function loadRememberedFocusTarget(targetId?: string) {
  return systemFocusHelpers.loadRememberedFocusTarget(targetId);
}

function detectFocusedInputWithGuard(
  rememberedTarget: {
    application?: string;
    windowTitle?: string;
    role?: string;
  } | null,
  targetId?: string,
  matchPolicy: 'strict' | 'prefix' | 'contains' = 'strict',
) {
  return systemFocusHelpers.detectFocusedInputWithGuard(rememberedTarget, targetId, matchPolicy);
}

function assertFocusedTargetMatches(
  rememberedTarget: {
    application?: string;
    windowTitle?: string;
    role?: string;
  } | null,
  focusedInput: {
    application?: string;
    windowTitle?: string;
    role?: string;
  },
  targetId?: string,
  matchPolicy: 'strict' | 'prefix' | 'contains' = 'strict',
) {
  return systemFocusHelpers.assertFocusedTargetMatches(rememberedTarget, focusedInput, targetId, matchPolicy);
}

function getFocusedTargetMismatches(
  rememberedTarget: {
    application?: string;
    windowTitle?: string;
    role?: string;
  } | null,
  focusedInput: {
    application?: string;
    windowTitle?: string;
    role?: string;
  },
  matchPolicy: 'strict' | 'prefix' | 'contains' = 'strict',
) {
  return systemFocusHelpers.getFocusedTargetMismatches(rememberedTarget, focusedInput, matchPolicy);
}

function windowTitleMatches(expected: string, actual: string, matchPolicy: 'strict' | 'prefix' | 'contains') {
  return systemFocusHelpers.windowTitleMatches(expected, actual, matchPolicy);
}

/**
 * Universal Pipeline Engine with Control Flow & Safety Guards
 * moved to system-pipeline-helpers.ts
 */

/**
 * Strategic Reconciliation
 */
async function performReconcile(input: SystemAction) {
  const strategyPath = pathResolver.rootResolve(input.strategy_path || 'knowledge/product/governance/system-strategy.json');
  if (!safeExistsSync(strategyPath)) throw new Error(`Strategy not found: ${strategyPath}`);
  const config = JSON.parse(safeReadFile(strategyPath, { encoding: 'utf8' }) as string);
  for (const strategy of config.strategies) {
    await executePipeline(strategy.pipeline, strategy.params || {}, input.options);
  }
  return { status: 'reconciled' };
}

/**
 * CLI Runner
 */
const main = async () => {
  const argv = await createStandardYargs()
    .option('input', { alias: 'i', type: 'string', required: true })
    .parseSync();
  const inputContent = safeReadFile(pathResolver.rootResolve(argv.input as string), { encoding: 'utf8' }) as string;
  const result = await handleAction(JSON.parse(inputContent));
  console.log(JSON.stringify(result, null, 2));
};

const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : '';
const modulePath = fileURLToPath(import.meta.url);

if (entrypoint && modulePath === entrypoint) {
  main().catch(err => {
    logger.error(err.message);
    process.exit(1);
  });
}

export { handleAction };
