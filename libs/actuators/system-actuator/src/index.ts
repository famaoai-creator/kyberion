import {
  logger,
  safeReadFile,
  safeWriteFile,
  safeMkdir,
  safeExec,
  safeExistsSync,
  derivePipelineStatus,
  activateApplication,
  detectFocusedInput,
  keystrokeText,
  pasteText,
  pressKey,
  clickAt,
  rightClickAt,
  moveMouse,
  listKnownAppCapabilities,
  listChromeTabs,
  activateChromeTabByTitle,
  emptyFinderTrash,
  type FocusedInputState,
} from '@agent/core';
import { getAllFiles } from '@agent/core/fs-utils';
import { createStandardYargs } from '@agent/core/cli-utils';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import * as visionJudge from '@agent/shared-vision';

/**
 * System-Actuator v2.1.0 [AUTONOMOUS CONTROL ENABLED]
 * Strictly compliant with Layer 2 (Shield).
 * Standardized with Control Flow (if/while) and Safety Guards.
 */
const ALLOW_UNSAFE_SHELL = process.env.KYBERION_ALLOW_UNSAFE_SHELL === 'true';
const ALLOW_UNSAFE_JS = process.env.KYBERION_ALLOW_UNSAFE_JS === 'true';
const COMPUTER_RUNTIME_DIR = path.resolve(process.cwd(), 'active/shared/runtime/computer');
const FOCUS_TARGET_STORE_PATH = path.join(COMPUTER_RUNTIME_DIR, 'focused-targets.json');

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
      | 'list_tabs'
      | 'activate_tab_by_title'
      | 'empty_trash'
      | 'type'
      | 'key'
      | 'wait';
    coordinate?: { x: number; y: number };
    text?: string;
    key?: string;
    application?: string;
    title?: string;
    focus_target_id?: string;
    input_strategy?: 'keystroke' | 'paste';
    timeout_ms?: number;
  };
}

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
    return {
      status: 'succeeded',
      results: [{ op: 'list_known_app_capabilities', status: 'success' }],
      context: {
        known_app_capabilities: listKnownAppCapabilities(),
      },
      total_steps: 1,
    };
  }

  if (interaction.type === 'list_tabs') {
    const tabs = listChromeTabs(application || 'Google Chrome');
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

  if (interaction.type === 'empty_trash') {
    emptyFinderTrash();
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

function ensureComputerRuntimeDir() {
  if (!safeExistsSync(COMPUTER_RUNTIME_DIR)) {
    safeMkdir(COMPUTER_RUNTIME_DIR, { recursive: true });
  }
}

function loadFocusTargetStore(): Record<string, any> {
  if (!safeExistsSync(FOCUS_TARGET_STORE_PATH)) {
    return {};
  }
  try {
    return JSON.parse(String(safeReadFile(FOCUS_TARGET_STORE_PATH, { encoding: 'utf8' }) || '{}'));
  } catch {
    return {};
  }
}

function saveFocusTargetStore(store: Record<string, any>) {
  ensureComputerRuntimeDir();
  safeWriteFile(FOCUS_TARGET_STORE_PATH, JSON.stringify(store, null, 2));
}

function rememberFocusedTarget(explicitId: string | undefined, focusedInput: FocusedInputState) {
  const targetId = explicitId || `focus-${Date.now()}`;
  const store = loadFocusTargetStore();
  store[targetId] = {
    id: targetId,
    application: focusedInput.application,
    windowTitle: focusedInput.windowTitle,
    role: focusedInput.role,
    description: focusedInput.description,
    editable: focusedInput.editable,
    updatedAt: new Date().toISOString(),
  };
  saveFocusTargetStore(store);
  return targetId;
}

function loadRememberedFocusTarget(targetId?: string) {
  if (!targetId) {
    return null;
  }
  const store = loadFocusTargetStore();
  return store[targetId] || null;
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
  let focusedInput = detectFocusedInput();
  const initialMismatch = getFocusedTargetMismatches(rememberedTarget, focusedInput, matchPolicy);
  if (initialMismatch.length === 0) {
    return focusedInput;
  }

  if (rememberedTarget?.application) {
    activateApplication(rememberedTarget.application);
    focusedInput = detectFocusedInput();
  }

  assertFocusedTargetMatches(rememberedTarget, focusedInput, targetId, matchPolicy);
  return focusedInput;
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
  if (!rememberedTarget || !targetId) {
    return;
  }

  const mismatches = getFocusedTargetMismatches(rememberedTarget, focusedInput, matchPolicy);

  if (mismatches.length > 0) {
    throw new Error(`Focused target guard failed for ${targetId}: ${mismatches.join(', ')}`);
  }
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
  if (!rememberedTarget) {
    return [];
  }

  const mismatches: string[] = [];
  if (rememberedTarget.application && focusedInput.application !== rememberedTarget.application) {
    mismatches.push(`application expected "${rememberedTarget.application}" got "${focusedInput.application || ''}"`);
  }
  if (rememberedTarget.windowTitle && !windowTitleMatches(rememberedTarget.windowTitle, focusedInput.windowTitle || '', matchPolicy)) {
    mismatches.push(`windowTitle expected "${rememberedTarget.windowTitle}" got "${focusedInput.windowTitle || ''}"`);
  }
  if (rememberedTarget.role && focusedInput.role && focusedInput.role !== rememberedTarget.role) {
    mismatches.push(`role expected "${rememberedTarget.role}" got "${focusedInput.role}"`);
  }
  return mismatches;
}

function windowTitleMatches(expected: string, actual: string, matchPolicy: 'strict' | 'prefix' | 'contains') {
  switch (matchPolicy) {
    case 'prefix':
      return actual.startsWith(expected);
    case 'contains':
      return actual.includes(expected);
    case 'strict':
    default:
      return actual === expected;
  }
}

/**
 * Universal Pipeline Engine with Control Flow & Safety Guards
 */
async function executePipeline(steps: PipelineStep[], initialCtx: any = {}, options: any = {}, state: any = { stepCount: 0, startTime: Date.now() }) {
  const rootDir = process.cwd();
  const MAX_STEPS = options.max_steps || 1000;
  const TIMEOUT = options.timeout_ms || 60000;

  let ctx = { ...initialCtx, timestamp: new Date().toISOString() };

  if (initialCtx.context_path && safeExistsSync(path.resolve(rootDir, initialCtx.context_path))) {
    const saved = JSON.parse(safeReadFile(path.resolve(rootDir, initialCtx.context_path), { encoding: 'utf8' }) as string);
    ctx = { ...ctx, ...saved };
  }

      const resolve = (val: any) => {
    if (typeof val !== 'string') return val;
    
    // 単一の変数参照 "{{var}}" の場合は、型を維持して生データを返す
    const singleVarMatch = val.match(/^{{(.*?)}}$/);
    if (singleVarMatch) {
      const parts = singleVarMatch[1].trim().split('.');
      let current = ctx;
      for (const part of parts) { current = current?.[part]; }
      return current !== undefined ? current : '';
    }

    // 文字列混在の場合は従来通り文字列展開
    return val.replace(/{{(.*?)}}/g, (_, p) => {
      const parts = p.trim().split('.');
      let current = ctx;
      for (const part of parts) { current = current?.[part]; }
      return current !== undefined ? (typeof current === 'object' ? JSON.stringify(current) : String(current)) : '';
    });
  };

  const results = [];
  for (const step of steps) {
    state.stepCount++;
    if (state.stepCount > MAX_STEPS) throw new Error(`[SAFETY_LIMIT] Exceeded maximum pipeline steps (${MAX_STEPS})`);
    if (Date.now() - state.startTime > TIMEOUT) throw new Error(`[SAFETY_LIMIT] Pipeline execution timed out (${TIMEOUT}ms)`);

    try {
      logger.info(`  [SYS_PIPELINE] [Step ${state.stepCount}] ${step.type}:${step.op}...`);

      if (step.type === 'control') {
        ctx = await opControl(step.op, step.params, ctx, options, state, resolve);
      } else if (step.type === 'capture') {
        ctx = await opCapture(step.op, step.params, ctx, resolve);
      } else if (step.type === 'transform') {
        ctx = await opTransform(step.op, step.params, ctx, resolve);
      } else if (step.type === 'apply') {
        ctx = await opApply(step.op, step.params, ctx, resolve);
      } else {
        throw new Error(`Unknown step type: ${step.type}`);
      }
      results.push({ op: step.op, status: 'success' });
    } catch (err: any) {

      logger.error(`  [SYS_PIPELINE] Step failed (${step.op}): ${err.message}`);
      results.push({ op: step.op, status: 'failed', error: err.message });
      break; 
    }
  }

  if (initialCtx.context_path) {
    safeWriteFile(path.resolve(rootDir, initialCtx.context_path), JSON.stringify(ctx, null, 2));
  }

  return { status: derivePipelineStatus(results), results, context: ctx, total_steps: state.stepCount };
}

async function opControl(op: string, params: any, ctx: any, options: any, state: any, resolve: Function) {
  switch (op) {
    case 'if':
      if (evaluateCondition(params.condition, ctx)) {
        const res = await executePipeline(params.then, ctx, options, state);
        return res.context;
      } else if (params.else) {
        const res = await executePipeline(params.else, ctx, options, state);
        return res.context;
      }
      return ctx;

    case 'while':
      let iterations = 0;
      const maxIter = params.max_iterations || 100;
      while (evaluateCondition(params.condition, ctx) && iterations < maxIter) {
        logger.info(`    [LOOP] Iteration ${++iterations}...`);
        const res = await executePipeline(params.pipeline, ctx, options, state);
        ctx = res.context;
      }
      if (iterations >= maxIter) logger.warn(`[SAFETY_GUARD] Loop reached max_iterations (${maxIter})`);
      return ctx;

    default: return ctx;
  }
}

function evaluateCondition(cond: any, ctx: any): boolean {
  if (!cond) return true;
  const parts = cond.from.split('.');
  let val = ctx;
  for (const part of parts) { val = val?.[part]; }

  switch (cond.operator) {
    case 'exists': return val !== undefined && val !== null;
    case 'not_exists': return val === undefined || val === null;
    case 'empty': return Array.isArray(val) ? val.length === 0 : !val;
    case 'not_empty': return Array.isArray(val) ? val.length > 0 : !!val;
    case 'eq': return val === cond.value;
    case 'ne': return val !== cond.value;
    default: return !!val;
  }
}

async function opCapture(op: string, params: any, ctx: any, resolve: Function) {
  const rootDir = process.cwd();
  switch (op) {
    case 'shell':
      assertUnsafeShellAllowed();
      return { ...ctx, [params.export_as || 'last_capture']: execSync(resolve(params.cmd), { encoding: 'utf8' }).trim() };
    case 'read_file':
      return { ...ctx, [params.export_as || 'last_capture']: safeReadFile(path.resolve(rootDir, resolve(params.path)), { encoding: 'utf8' }) };
    case 'read_json':
      return { ...ctx, [params.export_as || 'last_capture_data']: JSON.parse(safeReadFile(path.resolve(rootDir, resolve(params.path)), { encoding: 'utf8' }) as string) };
    case 'glob_files':
      return { ...ctx, [params.export_as || 'file_list']: getAllFiles(path.resolve(rootDir, resolve(params.dir))).filter(f => !params.ext || f.endsWith(params.ext)).map(f => path.relative(rootDir, f)) };
    case 'vision_consult':
      return { ...ctx, [params.export_as || 'vision_decision']: await visionJudge.consultVision(resolve(params.context), params.tie_break_options) };
    case 'pulse_status':
      const { ledger } = await import('@agent/core');
      return { ...ctx, [params.export_as || 'ledger_valid']: ledger.verifyIntegrity() };
    default: 
      throw new Error(`Unsupported capture operator in System-Actuator: ${op}`);
  }
}

async function opTransform(op: string, params: any, ctx: any, resolve: Function) {
  switch (op) {
    case 'regex_extract': {
      const input = String(ctx[params.from || 'last_capture'] || '');
      const match = input.match(new RegExp(params.pattern, 'm'));
      return { ...ctx, [params.export_as]: match ? match[1] : null };
    }
    case 'json_query': {
      const data = ctx[params.from || 'last_capture_data'];
      const result = params.path.split('.').reduce((o: any, i: string) => o?.[i], data);
      return { ...ctx, [params.export_as]: result };
    }
    case 'sre_analyze': {
      const { sre } = await import('@agent/core');
      return { ...ctx, [params.export_as || 'root_cause']: sre.analyzeRootCause(ctx[params.from || 'last_capture']) };
    }
    case 'run_js': {
      assertUnsafeJsAllowed();
      const { Buffer } = await import('node:buffer');
      const vm = await import('node:vm');
      const util = await import('node:util');
      const sandbox = { Buffer, process: { env: { ...process.env } }, console: { 
        log: (...args: any[]) => logger.info(`[JS-LOG] ${args.map(a => typeof a === 'object' ? util.inspect(a) : a).join(' ')}`),
        error: (...args: any[]) => logger.error(`[JS-ERROR] ${args.map(a => typeof a === 'object' ? util.inspect(a) : a).join(' ')}`)
      }, ctx: { ...ctx } };
      vm.createContext(sandbox);
      await new vm.Script(resolve(params.code)).runInContext(sandbox);
      return { ...sandbox.ctx };
    }
    default: 
      throw new Error(`Unsupported transform operator in System-Actuator: ${op}`);
  }
}

async function opApply(op: string, params: any, ctx: any, resolve: Function) {
  const rootDir = process.cwd();
  switch (op) {
    case 'keyboard':
      keystrokeText(String(resolve(params.text || '{{last_capture}}')));
      break;
    case 'paste_text': {
      const text = String(resolve(params.text || '{{last_capture}}'));
      pasteText(text);
      break;
    }
    case 'press_key': {
      const key = String(resolve(params.key || '')).trim().toLowerCase();
      pressKey(key);
      break;
    }
    case 'activate_application': {
      const application = String(resolve(params.application || '')).trim();
      if (!application) {
        throw new Error('Application name is required for activate_application');
      }
      if (process.platform === 'darwin') {
        activateApplication(application);
      }
      break;
    }
    case 'mouse_click':
      if (params.button === 'right') {
        rightClickAt(Number(params.x || 0), Number(params.y || 0), Number(params.click_count || 1));
      } else {
        clickAt(Number(params.x || 0), Number(params.y || 0), Number(params.click_count || 1));
      }
      break;
    case 'mouse_move':
      moveMouse(Number(params.x || 0), Number(params.y || 0));
      break;
    case 'wait':
      await new Promise((resolveDelay) => setTimeout(resolveDelay, Number(params.duration_ms || 1000)));
      break;
    case 'voice':
      const { say } = await import('@agent/core');
      await say(resolve(params.text || '{{last_capture}}'));
      break;
    case 'notify': logger.info(`🔔 [NOTIFICATION] ${resolve(params.text)}`); break;
    case 'write_file':
      const out = path.resolve(rootDir, resolve(params.path));
      const content = ctx[params.from || 'last_transform'] || ctx[params.from || 'last_capture'];
      if (!safeExistsSync(path.dirname(out))) safeMkdir(path.dirname(out), { recursive: true });
      safeWriteFile(out, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
      break;
    case 'mkdir': safeMkdir(path.resolve(rootDir, resolve(params.path)), { recursive: true }); break;
    case 'log': logger.info(`[SYSTEM_LOG] ${resolve(params.message || 'Action completed')}`); break;
    default: 
      throw new Error(`Unsupported apply operator in System-Actuator: ${op}`);
  }
  return ctx;
}


/**
 * Strategic Reconciliation
 */
async function performReconcile(input: SystemAction) {
  const strategyPath = path.resolve(process.cwd(), input.strategy_path || 'knowledge/governance/system-strategy.json');
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
  const inputContent = safeReadFile(path.resolve(process.cwd(), argv.input as string), { encoding: 'utf8' }) as string;
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
