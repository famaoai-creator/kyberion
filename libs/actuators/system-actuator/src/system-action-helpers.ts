import { logger, safeReadFile, safeExistsSync, pathResolver } from '@agent/core';
import { randomUUID } from 'node:crypto';
import { createApprovalRequest, loadApprovalRequest } from '@agent/core/governance';
import {
  activateApplication,
  detectFocusedInput,
  clickAt,
  rightClickAt,
  moveMouse,
  scrollAt,
  dragFrom,
  activateWindowByTitle,
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
import { emitComputerSurfacePatch } from '@agent/core';
import { systemFocusHelpers } from './system-focus-helpers.js';
import { executePipeline } from './system-pipeline-helpers.js';

export interface SystemPipelineStep {
  type: 'capture' | 'transform' | 'apply' | 'control';
  op: string;
  params: any;
}

export interface SystemAction {
  action: 'pipeline' | 'reconcile';
  steps?: SystemPipelineStep[];
  strategy_path?: string;
  context?: Record<string, any>;
  options?: {
    max_steps?: number;
    timeout_ms?: number;
  };
}

export interface ComputerInteractionAction {
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

function loadRememberedFocusTarget(targetId?: string) {
  return systemFocusHelpers.loadRememberedFocusTarget(targetId);
}

function rememberFocusedTarget(explicitId: string | undefined, focusedInput: any) {
  return systemFocusHelpers.rememberFocusedTarget(explicitId, focusedInput);
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

  const steps: SystemPipelineStep[] = [];
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

async function performReconcile(input: SystemAction) {
  const strategyPath = pathResolver.rootResolve(input.strategy_path || 'knowledge/product/governance/system-strategy.json');
  if (!safeExistsSync(strategyPath)) throw new Error(`Strategy not found: ${strategyPath}`);
  const config = JSON.parse(safeReadFile(strategyPath, { encoding: 'utf8' }) as string);
  for (const strategy of config.strategies) {
    await executePipeline(strategy.pipeline, strategy.params || {}, input.options);
  }
  return { status: 'reconciled' };
}

export async function handleSystemAction(input: SystemAction | ComputerInteractionAction): Promise<any> {
  if ((input as any).kind === 'computer_interaction') {
    return await handleComputerInteraction(input as ComputerInteractionAction);
  }
  if ((input as SystemAction).action === 'reconcile') {
    return await performReconcile(input as SystemAction);
  }
  return await executePipeline((input as SystemAction).steps || [], (input as SystemAction).context || {}, (input as SystemAction).options);
}
