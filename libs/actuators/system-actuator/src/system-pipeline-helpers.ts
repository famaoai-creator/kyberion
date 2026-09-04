import { distillTextObservation } from '@agent/core/observation-distill';
import { executeLlmDecideOp } from '@agent/core/semantic-decide';
import { logger } from '@agent/core/core';
import {
  assertSafeRepositoryPath,
  safeReadFile,
  safeWriteFile,
  safeExec,
  safeExistsSync,
  safeLstat,
} from '@agent/core/secure-io';
import { nowIso, parseSafeJsonInput, parseSafeJsonObjectValue } from '@agent/core/foundation';
import { runAdfActuatorPipeline } from '@agent/core/actuator-sdk';
import type { AdfEngineContext } from '@agent/core/adf-engine';
import { pathResolver } from '@agent/core/path-resolver';
import { resolveDesktopLaunchAdapter } from '@agent/core/desktop-launch-adapter';
import { getPathValue } from '@agent/core/src/logic-utils';
import { createVoiceCapabilityBridge } from '@agent/core/voice-capability-bridge';
import { retry } from '@agent/core/async-utils';
import {
  DEFAULT_MAX_PIPELINE_STEPS,
  DEFAULT_PIPELINE_TIMEOUT_MS,
} from '@agent/core/execution-bounds';
import {
  activateApplication,
  keystrokeText,
  pasteText,
  pressKey,
  toggleDictation,
  clickAt,
  rightClickAt,
  moveMouse,
  scrollAt,
  dragFrom,
  quitApplication,
  systemNotify,
  clipboardWrite,
} from '@agent/core/os-automation';
import { osAutomationBridge } from '@agent/core/os-automation-bridge';
import * as path from 'node:path';
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
} from './system-pipeline-core-helpers.js';
import type { PipelineStep } from './system-pipeline-core-helpers.js';

async function opTransform(op: string, params: any, ctx: any, resolve: (value: any) => any) {
  switch (op) {
    case 'distill_output': {
      // AR-07: deterministic distillation of command output (same text →
      // same distillate; bounded) so llm_decide never sees raw output.
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
    }
    case 'llm_decide': {
      // AR-07: one in-loop decision about a distilled observation
      // (distill_output first). Selection over generation; null decision
      // exports null + reason and never throws unless on_degraded: 'fail'.
      return executeLlmDecideOp({ params, ctx, resolve, defaultFromKey: 'output_distillate' });
    }
    case 'regex_extract': {
      const input = String(ctx[params.from || 'last_capture'] || '');
      const match = input.match(new RegExp(params.pattern, 'm'));
      return { ...ctx, [params.export_as]: match ? match[1] : null };
    }
    case 'json_query': {
      const data = ctx[params.from || 'last_capture_data'];
      const result = getPathValue(data, params.path);
      return { ...ctx, [params.export_as]: result };
    }
    case 'sre_analyze': {
      const { sre } = await import('@agent/core/core');
      return {
        ...ctx,
        [params.export_as || 'root_cause']: sre.analyzeRootCause(
          ctx[params.from || 'last_capture']
        ),
      };
    }
    case 'run_js': {
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
    }
    default:
      throw new Error(buildUnknownSystemOpMessage(op));
  }
}

async function opApply(op: string, params: any, ctx: any, resolve: (value: any) => any) {
  const rootDir = pathResolver.rootDir();
  assertSystemOpInput(op, params);
  if (SYSTEM_ACTUATOR_CAPTURE_ALIAS_OPS.has(op)) {
    return opCapture(op === 'list' ? 'list_missions' : op, params, ctx, resolve);
  }
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
      const key = String(resolve(params.key || ''))
        .trim()
        .toLowerCase();
      pressKey(key);
      break;
    }
    case 'voice_input_toggle': {
      if (process.platform !== 'darwin') {
        throw new Error('voice_input_toggle is only supported on macOS');
      }
      const dictationKeycode = Number(resolve(params.dictation_keycode ?? 176));
      toggleDictation(dictationKeycode);
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
      await new Promise((resolveDelay) =>
        setTimeout(resolveDelay, Number(params.duration_ms || 1000))
      );
      break;
    case 'voice':
      const { say } = await import('@agent/core/voice-synth');
      await say(resolve(params.text || '{{last_capture}}'));
      break;
    case 'native_tts_speak': {
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
      ctx = { ...ctx, [params.export_as || 'last_tts_result']: result };
      if (!result.ok) {
        logger.warn(`[NATIVE_TTS] Speak failed: ${result.error}`);
      }
      break;
    }
    case 'check_native_tts': {
      const status = await createVoiceCapabilityBridge().probe();
      ctx = { ...ctx, [params.export_as || 'tts_status']: status };
      if (!status.available) {
        logger.warn(`[NATIVE_TTS] ${status.reason ?? 'native TTS unavailable'}`);
      }
      break;
    }
    case 'open_url': {
      const url = String(resolve(params.url || ''));
      if (!url) throw new Error('open_url requires "url" param');
      if (!/^(https?|file):\/\//.test(url)) {
        throw new Error(`open_url refused unsupported URL scheme: ${url.slice(0, 64)}`);
      }
      try {
        const launcher = resolveDesktopLaunchAdapter();
        await retry(async () => launcher.open(url, rootDir), buildRetryOptions(params.retry));
        ctx = { ...ctx, [params.export_as || 'opened_url']: url };
      } catch (err: any) {
        logger.warn(`[OPEN_URL] Failed to open ${url}: ${err.message}`);
        ctx = { ...ctx, [params.export_as || 'opened_url']: null };
      }
      break;
    }
    case 'notify': {
      const title = String(resolve(params.title || 'Kyberion'));
      const message = String(resolve(params.message || params.text || ''));
      const subtitle = params.subtitle ? String(resolve(params.subtitle)) : undefined;
      systemNotify(title, message, subtitle);
      break;
    }
    case 'write_file':
    case 'write_artifact':
      await delegateToFilePipeline(
        {
          type: 'apply',
          op,
          params,
        },
        ctx
      );
      break;
    case 'mkdir':
      await delegateToFilePipeline(
        {
          type: 'apply',
          op: 'mkdir',
          params,
        },
        ctx
      );
      break;
    case 'log':
      logger.info(`[SYSTEM_LOG] ${resolve(params.message || 'Action completed')}`);
      break;
    case 'write_json':
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
      break;
    case 'scroll': {
      const direction = String(resolve(params.direction || 'down')) as
        'up' | 'down' | 'left' | 'right';
      scrollAt(
        Number(resolve(params.x || 0)),
        Number(resolve(params.y || 0)),
        direction,
        Number(resolve(params.amount || 3))
      );
      break;
    }
    case 'drag':
      dragFrom(
        Number(resolve(params.from_x || 0)),
        Number(resolve(params.from_y || 0)),
        Number(resolve(params.to_x || 0)),
        Number(resolve(params.to_y || 0))
      );
      break;
    case 'run_applescript': {
      assertUnsafeShellAllowed();
      const script = String(resolve(params.script || ''));
      if (!script) throw new Error('run_applescript requires "script" param');
      const result = await retry(
        async () => osAutomationBridge.runAppleScript(script),
        buildRetryOptions(params.retry)
      );
      ctx = { ...ctx, [params.export_as || 'applescript_result']: result };
      break;
    }
    case 'system_notify': {
      warnDeprecatedSystemOpAlias('system_notify', 'notify');
      const title = String(resolve(params.title || 'Kyberion'));
      const message = String(resolve(params.message || params.text || ''));
      const subtitle = params.subtitle ? String(resolve(params.subtitle)) : undefined;
      systemNotify(title, message, subtitle);
      break;
    }
    case 'open_file': {
      const filePath = String(resolve(params.path || ''));
      if (!filePath) throw new Error('open_file requires "path" param');
      const absPath = assertSafeRepositoryPath(pathResolver.rootResolve(filePath));
      const launcher = resolveDesktopLaunchAdapter();
      await retry(async () => launcher.open(absPath, rootDir), buildRetryOptions(params.retry));
      break;
    }
    case 'process_kill': {
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
      break;
    }
    case 'app_quit': {
      const appName = String(resolve(params.application || ''));
      if (!appName) throw new Error('app_quit requires "application" param');
      quitApplication(appName);
      break;
    }
    case 'clipboard_write': {
      const text = String(resolve(params.text || ''));
      clipboardWrite(text);
      break;
    }
    default:
      throw new Error(buildUnknownSystemOpMessage(op));
  }
  return ctx;
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
    const saved = parseSafeJsonObjectValue(
      parseSafeJsonInput(
        String(safeReadFile(contextPath, { encoding: 'utf8' }) || ''),
        'system context'
      ),
      'system context'
    );
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
