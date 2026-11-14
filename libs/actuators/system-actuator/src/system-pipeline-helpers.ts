import { runAppleShortcut } from '@agent/core/shortcut-bridge';
import { distillTextObservation } from '@agent/core/observation-distill';
import { executeLlmDecideOp } from '@agent/core/semantic-decide';
import { logger } from '@agent/core/core';
import {
  assertSafeRepositoryPath,
  safeWriteFile,
  safeExec,
  safeExistsSync,
  safeLstat,
} from '@agent/core/secure-io';
import { nowIso, parseSafeJsonObjectValue, readJson } from '@agent/core/foundation';
import { runAdfActuatorPipeline } from '@agent/core/actuator/actuator-sdk';
import type { AdfEngineContext } from '@agent/core/pipeline/adf-engine';
import { pathResolver } from '@agent/core/path-resolver';
import { resolveDesktopLaunchAdapter } from '@agent/core/virtual/desktop-launch-adapter';
import { getPathValue } from '@agent/core/pipeline/logic-utils';
import { createVoiceCapabilityBridge } from '@agent/shared-voice/voice-capability-bridge';
import { retry } from '@agent/core/async-utils';
import {
  DEFAULT_MAX_PIPELINE_STEPS,
  DEFAULT_PIPELINE_TIMEOUT_MS,
} from '@agent/core/contracts/execution-bounds';
import {
  performMouseOperation,
  launchApplication,
  activateApplication,
  activateWindowByTitle,
  setWindowState,
  keystrokeText,
  pasteText,
  pressKeyChord,
  toggleDictation,
  quitApplication,
  systemNotify,
  clipboardWrite,
} from '@agent/core/virtual/os-automation';
import { osAutomationBridge } from '@agent/core/virtual/os-automation-bridge';
import { isMacOS } from '@agent/core/platform';
import * as path from 'node:path';
import { resolveSystemClickCoordinate } from './system-mark-target.js';
import {
  assertUnsafeShellAllowed,
  assertUnsafeJsAllowed,
  buildRetryOptions,
  delegateToFilePipeline,
  buildUnknownSystemOpMessage,
  warnDeprecatedSystemOpAlias,
  assertSystemOpInput,
  normalizeDisplayName,
  normalizeApplicationName,
  normalizeDisplayIndex,
  selectDisplayFromInventory,
  resolveScreenDisplaySelection,
  SYSTEM_ACTUATOR_CAPTURE_ALIAS_OPS,
  loadFocusTargetStore,
  saveFocusTargetStore,
  rememberFocusedTarget,
  loadRememberedFocusTarget,
  detectFocusedInputWithGuard,
  assertFocusedTargetMatches,
  getFocusedTargetMismatches,
  windowTitleMatches,
  opControl,
  opCapture,
  opProcedure,
} from './system-pipeline-core-helpers.js';
import type { PipelineStep } from './system-pipeline-core-helpers.js';

type SystemOpDispatch = {
  op: string;
  params: any;
  ctx: any;
  resolve: (value: any) => any;
  rootDir: string;
};
type SystemOpHandler = (d: SystemOpDispatch) => any | Promise<any>;

/** transform ops — each returns the next ctx. Adding an op = one entry. */
const OP_TRANSFORM_HANDLERS: Record<string, SystemOpHandler> = {
  // AR-07: deterministic distillation of command output (same text →
  // same distillate; bounded) so llm_decide never sees raw output.
  distill_output: ({ params, ctx, resolve }) => {
    const fromKey = String(params.from || 'last_exec');
    const source = params.text != null ? resolve(params.text) : ctx[fromKey];
    const text =
      typeof source === 'string'
        ? source
        : [source?.stdout, source?.stderr].filter(Boolean).join('\n') ||
          JSON.stringify(source ?? '');
    const distillate = distillTextObservation(text, {
      maxHeadLines: params.max_head_lines,
      maxTailLines: params.max_tail_lines,
      maxErrorLines: params.max_error_lines,
    });
    return { ...ctx, [params.export_as || 'output_distillate']: distillate };
  },
  // AR-07: one in-loop decision about a distilled observation
  // (distill_output first). Selection over generation; null decision
  // exports null + reason and never throws unless on_degraded: 'fail'.
  llm_decide: ({ params, ctx, resolve }) =>
    executeLlmDecideOp({ params, ctx, resolve, defaultFromKey: 'output_distillate' }),
  regex_extract: ({ params, ctx }) => {
    const input = String(ctx[params.from || 'last_capture'] || '');
    const match = input.match(new RegExp(params.pattern, 'm'));
    return { ...ctx, [params.export_as]: match ? match[1] : null };
  },
  json_query: ({ params, ctx }) => {
    const data = ctx[params.from || 'last_capture_data'];
    const result = getPathValue(data, params.path);
    return { ...ctx, [params.export_as]: result };
  },
  sre_analyze: async ({ params, ctx }) => {
    const { sre } = await import('@agent/core/core');
    return {
      ...ctx,
      [params.export_as || 'root_cause']: sre.analyzeRootCause(ctx[params.from || 'last_capture']),
    };
  },
  run_js: async ({ params, ctx, resolve }) => {
    assertUnsafeJsAllowed();
    const { Buffer } = await import('node:buffer');
    const vm = await import('node:vm');
    const util = await import('node:util');
    const sandbox = {
      Buffer,
      process: { env: { ...process.env } },
      console: {
        log: (...args: any[]) =>
          logger.info(
            `[JS-LOG] ${args.map((a) => (typeof a === 'object' ? util.inspect(a) : a)).join(' ')}`
          ),
        error: (...args: any[]) =>
          logger.error(
            `[JS-ERROR] ${args.map((a) => (typeof a === 'object' ? util.inspect(a) : a)).join(' ')}`
          ),
      },
      ctx: { ...ctx },
    };
    vm.createContext(sandbox);
    await new vm.Script(resolve(params.code)).runInContext(sandbox);
    return { ...sandbox.ctx };
  },
};

/** apply ops — each returns the next ctx. Adding an op = one entry. */
const OP_APPLY_HANDLERS: Record<string, SystemOpHandler> = {
  run_shortcut: async ({ params, ctx, resolve }) => {
    const result = await runAppleShortcut({
      name: String(resolve(params.name)),
      ...(params.input !== undefined ? { input: String(resolve(params.input)) } : {}),
      ...(params.approval_request_id
        ? { approval_request_id: String(resolve(params.approval_request_id)) }
        : {}),
      ...(params.timeout_ms !== undefined
        ? { timeout_ms: Number(resolve(params.timeout_ms)) }
        : {}),
    });
    return { ...ctx, [String(params.export_as ?? 'shortcut_result')]: result };
  },
  standard_pr_lifecycle: ({ op, params, ctx, resolve }) => opProcedure(op, params, ctx, resolve),
  provider_preflight: ({ op, params, ctx, resolve }) => opProcedure(op, params, ctx, resolve),
  keyboard: ({ params, ctx, resolve }) => {
    keystrokeText(String(resolve(params.text || '{{last_capture}}')));
    return ctx;
  },
  paste_text: ({ params, ctx, resolve }) => {
    const text = String(resolve(params.text || '{{last_capture}}'));
    pasteText(text);
    return ctx;
  },
  press_key: ({ params, ctx, resolve }) => {
    const key = String(resolve(params.key || ''))
      .trim()
      .toLowerCase();
    const modifiers = Array.isArray(params.modifiers)
      ? params.modifiers.map((m: unknown) => String(resolve(m)))
      : [];
    pressKeyChord(key, modifiers);
    return ctx;
  },
  voice_input_toggle: ({ params, ctx, resolve }) => {
    if (!isMacOS()) {
      throw new Error('voice_input_toggle is only supported on macOS');
    }
    const dictationKeycode = Number(resolve(params.dictation_keycode ?? 176));
    toggleDictation(dictationKeycode);
    return ctx;
  },
  activate_application: ({ params, ctx, resolve }) => {
    const application = String(resolve(params.application || '')).trim();
    if (!application) {
      throw new Error('Application name is required for activate_application');
    }
    activateApplication(application);
    return ctx;
  },
  app_launch: ({ params, ctx, resolve }) => {
    const application = String(resolve(params.application || '')).trim();
    if (!application) throw new Error('app_launch requires "application" param');
    if (!launchApplication(application))
      throw new Error(`Could not launch application: ${application}`);
    return ctx;
  },
  window_focus: ({ params, ctx, resolve }) => {
    const application = String(resolve(params.application || '')).trim();
    const title = String(resolve(params.window_title || '')).trim();
    if (!application || !title)
      throw new Error('window_focus requires application and window_title');
    const policy = String(params.match_policy || 'contains') as 'strict' | 'prefix' | 'contains';
    if (!activateWindowByTitle(application, title, policy)) {
      throw new Error(`Could not focus window "${title}" for ${application}`);
    }
    return ctx;
  },
  window_maximize: ({ params, ctx, resolve }) => {
    const application = String(resolve(params.application || '')).trim();
    const title = String(resolve(params.window_title || '')).trim();
    if (!application || !title)
      throw new Error('window_maximize requires application and window_title');
    const policy = String(params.match_policy || 'contains') as 'strict' | 'prefix' | 'contains';
    if (!setWindowState(application, title, 'maximize', policy)) {
      throw new Error(`Could not maximize window "${title}" for ${application}`);
    }
    return ctx;
  },
  mouse_click: async ({ params, ctx }) => {
    const point = (await resolveSystemClickCoordinate(params, ctx.session_id)) ?? { x: 0, y: 0 };
    performMouseOperation({
      type: 'click',
      x: point.x,
      y: point.y,
      button: params.button === 'right' ? 'right' : 'left',
      count: Number(params.click_count || 1),
    });
    return ctx;
  },
  mouse_move: ({ params, ctx }) => {
    performMouseOperation({ type: 'move', x: Number(params.x || 0), y: Number(params.y || 0) });
    return ctx;
  },
  wait: async ({ params, ctx }) => {
    // The published op contract (op-input-contracts.ts) names this `ms`, and
    // every authored pipeline uses that spelling; reading only `duration_ms`
    // silently collapsed every declared wait to the 1s default — a scenario
    // asking for 8s between page transitions got 1s and raced the navigation.
    const waitMs = Number(params.ms ?? params.duration_ms ?? 1000);
    await new Promise((resolveDelay) =>
      setTimeout(resolveDelay, Number.isFinite(waitMs) && waitMs >= 0 ? waitMs : 1000)
    );
    return ctx;
  },
  voice: async ({ params, ctx, resolve }) => {
    const { say } = await import('@agent/shared-voice/voice-synth');
    await say(resolve(params.text || '{{last_capture}}'));
    return ctx;
  },
  native_tts_speak: async ({ params, ctx, resolve }) => {
    const text = String(resolve(params.text || '{{last_capture}}'));
    const result = await retry(
      async () =>
        createVoiceCapabilityBridge().speak(text, {
          voice: params.voice ? String(resolve(params.voice)) : undefined,
          rate: typeof params.rate === 'number' ? params.rate : undefined,
          timeoutMs: typeof params.timeout_ms === 'number' ? params.timeout_ms : undefined,
          silent: true,
        }),
      buildRetryOptions(params.retry)
    );
    const next = { ...ctx, [params.export_as || 'last_tts_result']: result };
    if (!result.ok) {
      logger.warn(`[NATIVE_TTS] Speak failed: ${result.error}`);
    }
    return next;
  },
  check_native_tts: async ({ params, ctx }) => {
    const status = await createVoiceCapabilityBridge().probe();
    const next = { ...ctx, [params.export_as || 'tts_status']: status };
    if (!status.available) {
      logger.warn(`[NATIVE_TTS] ${status.reason ?? 'native TTS unavailable'}`);
    }
    return next;
  },
  open_url: async ({ params, ctx, resolve, rootDir }) => {
    const url = String(resolve(params.url || ''));
    if (!url) throw new Error('open_url requires "url" param');
    if (!/^(https?|file):\/\//.test(url)) {
      throw new Error(`open_url refused unsupported URL scheme: ${url.slice(0, 64)}`);
    }
    try {
      const launcher = resolveDesktopLaunchAdapter();
      await retry(async () => launcher.open(url, rootDir), buildRetryOptions(params.retry));
      return { ...ctx, [params.export_as || 'opened_url']: url };
    } catch (err: any) {
      logger.warn(`[OPEN_URL] Failed to open ${url}: ${err.message}`);
      return { ...ctx, [params.export_as || 'opened_url']: null };
    }
  },
  notify: ({ params, ctx, resolve }) => {
    const title = String(resolve(params.title || 'Kyberion'));
    const message = String(resolve(params.message || params.text || ''));
    const subtitle = params.subtitle ? String(resolve(params.subtitle)) : undefined;
    systemNotify(title, message, subtitle);
    return ctx;
  },
  write_file: async ({ op, params, ctx }) => {
    await delegateToFilePipeline({ type: 'apply', op, params }, ctx);
    return ctx;
  },
  write_artifact: async ({ op, params, ctx }) => {
    await delegateToFilePipeline({ type: 'apply', op, params }, ctx);
    return ctx;
  },
  mkdir: async ({ params, ctx }) => {
    await delegateToFilePipeline({ type: 'apply', op: 'mkdir', params }, ctx);
    return ctx;
  },
  log: ({ params, ctx, resolve }) => {
    logger.info(`[SYSTEM_LOG] ${resolve(params.message || 'Action completed')}`);
    return ctx;
  },
  write_json: async ({ params, ctx, resolve }) => {
    await delegateToFilePipeline(
      {
        type: 'apply',
        op: 'write_file',
        params: {
          path: resolve(params.path),
          content: params.content
            ? resolve(params.content)
            : params.from
              ? getPathValue(ctx, params.from)
              : ctx.last_capture_data,
        },
      },
      ctx
    );
    return ctx;
  },
  scroll: ({ params, ctx, resolve }) => {
    const direction = String(resolve(params.direction || 'down')) as
      'up' | 'down' | 'left' | 'right';
    performMouseOperation({
      type: 'scroll',
      x: Number(resolve(params.x || 0)),
      y: Number(resolve(params.y || 0)),
      direction,
      amount: Number(resolve(params.amount || 3)),
    });
    return ctx;
  },
  drag: ({ params, ctx, resolve }) => {
    performMouseOperation({
      type: 'drag',
      fromX: Number(resolve(params.from_x || 0)),
      fromY: Number(resolve(params.from_y || 0)),
      toX: Number(resolve(params.to_x || 0)),
      toY: Number(resolve(params.to_y || 0)),
    });
    return ctx;
  },
  run_applescript: async ({ params, ctx, resolve }) => {
    assertUnsafeShellAllowed();
    const script = String(resolve(params.script || ''));
    if (!script) throw new Error('run_applescript requires "script" param');
    const result = await retry(
      async () => osAutomationBridge.runAppleScript(script),
      buildRetryOptions(params.retry)
    );
    return { ...ctx, [params.export_as || 'applescript_result']: result };
  },
  system_notify: ({ params, ctx, resolve }) => {
    warnDeprecatedSystemOpAlias('system_notify', 'notify');
    const title = String(resolve(params.title || 'Kyberion'));
    const message = String(resolve(params.message || params.text || ''));
    const subtitle = params.subtitle ? String(resolve(params.subtitle)) : undefined;
    systemNotify(title, message, subtitle);
    return ctx;
  },
  open_file: async ({ params, ctx, resolve, rootDir }) => {
    const filePath = String(resolve(params.path || ''));
    if (!filePath) throw new Error('open_file requires "path" param');
    const absPath = assertSafeRepositoryPath(pathResolver.rootResolve(filePath));
    const launcher = resolveDesktopLaunchAdapter();
    await retry(async () => launcher.open(absPath, rootDir), buildRetryOptions(params.retry));
    return ctx;
  },
  process_kill: async ({ params, ctx, resolve, rootDir }) => {
    assertUnsafeShellAllowed();
    if (params.pid) {
      const pid = Number(resolve(params.pid));
      if (!Number.isInteger(pid) || pid <= 0)
        throw new Error(`process_kill: invalid pid "${params.pid}"`);
      await retry(
        async () => process.kill(pid, params.signal || 'SIGTERM'),
        buildRetryOptions(params.retry)
      );
    } else if (params.name) {
      const name = String(resolve(params.name));
      await retry(
        async () => safeExec('pkill', ['-f', name], { cwd: rootDir }),
        buildRetryOptions(params.retry)
      );
    } else {
      throw new Error('process_kill requires "pid" or "name" param');
    }
    return ctx;
  },
  app_quit: ({ params, ctx, resolve }) => {
    const appName = String(resolve(params.application || ''));
    if (!appName) throw new Error('app_quit requires "application" param');
    quitApplication(appName);
    return ctx;
  },
  clipboard_write: ({ params, ctx, resolve }) => {
    const text = String(resolve(params.text || ''));
    clipboardWrite(text);
    return ctx;
  },
};

async function opTransform(op: string, params: any, ctx: any, resolve: (value: any) => any) {
  const handler = OP_TRANSFORM_HANDLERS[op];
  if (!handler) throw new Error(buildUnknownSystemOpMessage(op));
  return handler({ op, params, ctx, resolve, rootDir: '' });
}

async function opApply(op: string, params: any, ctx: any, resolve: (value: any) => any) {
  const rootDir = pathResolver.rootDir();
  assertSystemOpInput(op, params);
  if (SYSTEM_ACTUATOR_CAPTURE_ALIAS_OPS.has(op)) {
    return opCapture(op === 'list' ? 'list_missions' : op, params, ctx, resolve);
  }
  const handler = OP_APPLY_HANDLERS[op];
  if (!handler) throw new Error(buildUnknownSystemOpMessage(op));
  return handler({ op, params, ctx, resolve, rootDir });
}

// AR-01 Task 2: hand-rolled loop replaced by the canonical engine
// (runAdfActuatorPipeline). Nested control failures now propagate instead of being
// silently absorbed (AR-06 no-silent-failure).
async function executePipeline(
  steps: PipelineStep[],
  initialCtx: AdfEngineContext = {},
  options: { max_steps?: number; timeout_ms?: number } = {}
) {
  const rootDir = pathResolver.rootDir();
  const MAX_STEPS = options.max_steps || DEFAULT_MAX_PIPELINE_STEPS;
  const TIMEOUT = options.timeout_ms || DEFAULT_PIPELINE_TIMEOUT_MS;

  let ctx: AdfEngineContext = { ...initialCtx, timestamp: nowIso() };

  const contextPath =
    typeof initialCtx.context_path === 'string' && initialCtx.context_path
      ? assertSafeRepositoryPath(path.resolve(rootDir, initialCtx.context_path), {
          allowMissingLeaf: true,
        })
      : undefined;
  if (contextPath && safeExistsSync(contextPath)) {
    if (!safeLstat(contextPath).isFile()) {
      throw new Error(`system context must be an existing regular file: ${contextPath}`);
    }
    const saved = parseSafeJsonObjectValue(readJson(contextPath), 'system context');
    ctx = { ...ctx, ...saved };
  }

  const result = await runAdfActuatorPipeline({
    actuatorId: 'system',
    steps,
    context: ctx,
    options: { maxSteps: MAX_STEPS, timeoutMs: TIMEOUT },
    handlers: {
      capture: opCapture,
      transform: opTransform,
      apply: opApply,
      control: opControl,
    },
  });
  ctx = result.context;

  if (contextPath) {
    safeWriteFile(contextPath, JSON.stringify(ctx, null, 2));
  }

  return result;
}

export {
  executePipeline,
  resolveScreenDisplaySelection,
  normalizeDisplayName,
  normalizeApplicationName,
  normalizeDisplayIndex,
  selectDisplayFromInventory,
  loadFocusTargetStore,
  saveFocusTargetStore,
  rememberFocusedTarget,
  loadRememberedFocusTarget,
  detectFocusedInputWithGuard,
  assertFocusedTargetMatches,
  getFocusedTargetMismatches,
  windowTitleMatches,
};
