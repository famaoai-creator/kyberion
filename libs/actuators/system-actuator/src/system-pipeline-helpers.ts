import {
  logger,
  safeReadFile,
  safeWriteFile,
  safeMkdir,
  safeExec,
  safeExecResult,
  safeExistsSync,
  derivePipelineStatus,
  executeAdfSteps,
  pathResolver,
  resolveVars,
  evaluateCondition,
  getPathValue,
  resolveWriteArtifactSpec,
  nativeTtsSpeak,
  probeNativeTts,
  classifyError,
  retry,
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
  buildUnknownActuatorOpError,
  type ScreenDisplayInventory,
  type ScreenDisplayRecord,
  StubVideoFrameBus,
  writeVideoFrameBusToMp4,
  pipeMp4ToVideoFrameBus,
  assertExecutionBounds,
  withinLoopBounds,
  DEFAULT_MAX_PIPELINE_STEPS,
  DEFAULT_PIPELINE_TIMEOUT_MS,
  DEFAULT_MAX_LOOP_ITERATIONS,
} from '@agent/core';
import { handleAction as handleFileAction } from '../../file-actuator/src/file-pipeline-helpers.js';
import { getAllFiles } from '@agent/core/fs-utils';
import { createApprovalRequest, loadApprovalRequest } from '@agent/core/governance';
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
import type { FocusedInputState } from '@agent/core/os-automation';
import { osAutomationBridge } from '@agent/core/os-automation-bridge';
import { validateOpInput } from '@agent/core';
import {
  systemDisplayHelpers,
  type ResolvedScreenDisplaySelection,
} from './system-display-helpers.js';
import { systemFocusHelpers } from './system-focus-helpers.js';
import * as visionJudge from '@agent/shared-vision';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

const ALLOW_UNSAFE_SHELL = process.env.KYBERION_ALLOW_UNSAFE_SHELL === 'true';
const ALLOW_UNSAFE_JS = process.env.KYBERION_ALLOW_UNSAFE_JS === 'true';
const COMPUTER_RUNTIME_DIR = pathResolver.shared('runtime/computer');
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
const warnedSystemOpAliases = new Set<string>();

let cachedRecoveryPolicy: Record<string, any> | undefined;

interface PipelineStep {
  type: 'capture' | 'transform' | 'apply' | 'control';
  op: string;
  params: any;
}

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

async function delegateToFilePipeline(step: PipelineStep, ctx: any): Promise<any> {
  const delegatedCtx = { ...ctx };
  delete delegatedCtx.context_path;
  const result = await handleFileAction({
    action: 'pipeline',
    steps: [step],
    context: delegatedCtx,
  } as any);
  return result.context || ctx;
}

function buildUnknownSystemOpMessage(op: string): string {
  return buildUnknownActuatorOpError('system', op).message;
}

function warnDeprecatedSystemOpAlias(alias: string, canonical: string) {
  const warningKey = `${alias}->${canonical}`;
  if (warnedSystemOpAliases.has(warningKey)) return;
  warnedSystemOpAliases.add(warningKey);
  logger.warn(`[system-actuator] alias "${alias}" is deprecated; use "${canonical}" instead.`);
}

function assertSystemOpInput(op: string, params: any) {
  const validation = validateOpInput('system', op, params);
  if (!validation.valid) {
    throw new Error(
      `[INVALID_OP_INPUT] system:${op} ${'errors' in validation ? validation.errors.join('; ') : ''}`
    );
  }
}

function promoteDelegatedCapture(resultCtx: any, params: any, fallbackKey: string): any {
  const exportAs = params.export_as;
  if (!exportAs || resultCtx?.[exportAs] !== undefined) return resultCtx;
  if (resultCtx?.[fallbackKey] === undefined) return resultCtx;
  return { ...resultCtx, [exportAs]: resultCtx[fallbackKey] };
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

const SYSTEM_ACTUATOR_CAPTURE_ALIAS_OPS = new Set<string>([
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
  'resolve_path',
  'sample_traces',
  'vision_consult',
  'test_screen_stream',
  'test_screen_mp4_roundtrip',
  'test_camera_injection',
  'list',
]);

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
  matchPolicy: 'strict' | 'prefix' | 'contains' = 'strict'
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
  matchPolicy: 'strict' | 'prefix' | 'contains' = 'strict'
) {
  return systemFocusHelpers.assertFocusedTargetMatches(
    rememberedTarget,
    focusedInput,
    targetId,
    matchPolicy
  );
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
  matchPolicy: 'strict' | 'prefix' | 'contains' = 'strict'
) {
  return systemFocusHelpers.getFocusedTargetMismatches(rememberedTarget, focusedInput, matchPolicy);
}

function windowTitleMatches(
  expected: string,
  actual: string,
  matchPolicy: 'strict' | 'prefix' | 'contains'
) {
  return systemFocusHelpers.windowTitleMatches(expected, actual, matchPolicy);
}

async function opControl(
  op: string,
  params: any,
  ctx: any,
  runSteps: (steps: any[], seedCtx?: any) => Promise<any>,
  _resolve: (value: any) => any
) {
  const runNested = async (steps: any[], seedCtx: any) => {
    const res = await runSteps(steps, seedCtx);
    if (res.status === 'failed') {
      throw new Error(
        res.results.find((entry: any) => entry.status === 'failed')?.error ||
          'nested pipeline failed'
      );
    }
    return res.context;
  };

  switch (op) {
    case 'if':
      if (evaluateCondition(params.condition, ctx)) {
        return await runNested(params.then, ctx);
      } else if (params.else) {
        return await runNested(params.else, ctx);
      }
      return ctx;

    case 'while': {
      let iterations = 0;
      const maxIter = params.max_iterations || undefined;
      while (evaluateCondition(params.condition, ctx) && withinLoopBounds(iterations, maxIter)) {
        logger.info(`    [LOOP] Iteration ${++iterations}...`);
        ctx = await runNested(params.pipeline, ctx);
      }
      if (!withinLoopBounds(iterations, maxIter))
        logger.warn(
          `[SAFETY_GUARD] Loop reached max_iterations (${maxIter ?? DEFAULT_MAX_LOOP_ITERATIONS})`
        );
      return ctx;
    }

    default:
      throw new Error(buildUnknownSystemOpMessage(op));
  }
}

async function opCapture(op: string, params: any, ctx: any, resolve: (value: any) => any) {
  const rootDir = pathResolver.rootDir();
  assertSystemOpInput(op, params);
  switch (op) {
    case 'screenshot': {
      const displaySelection = await systemDisplayHelpers.resolveScreenDisplaySelection(
        params,
        resolve
      );
      const application = typeof params.application === 'string' ? params.application.trim() : '';
      const windowTitle = typeof params.window_title === 'string' ? params.window_title.trim() : '';
      const windowMatchPolicy =
        typeof params.window_match_policy === 'string' ? params.window_match_policy : 'strict';
      let captureMode: 'screen' | 'focused_window' = 'screen';
      let screenshotPath =
        typeof params.path === 'string' && params.path.trim()
          ? pathResolver.rootResolve(resolve(params.path))
          : pathResolver.shared(`runtime/computer/screenshots/screenshot-${Date.now()}.png`);
      if (!safeExistsSync(path.dirname(screenshotPath))) {
        safeMkdir(path.dirname(screenshotPath), { recursive: true });
      }
      if (application) {
        activateApplication(application);
        captureMode = 'focused_window';
      }
      let windowCandidates: string[] | undefined;
      if (application) {
        windowCandidates = getWindowList(application);
      }
      if (windowTitle) {
        activateWindowByTitle(application || 'Google Chrome', windowTitle, windowMatchPolicy);
        captureMode = 'focused_window';
      }
      const bridge = createScreenCaptureBridge();
      const captureResult = await bridge.captureScreenshot({
        save_path: screenshotPath,
        display_index: displaySelection.display_index,
        capture_mode: captureMode,
        application: application || undefined,
        window_title: windowTitle || undefined,
        window_match_policy: windowMatchPolicy,
      } as any);
      screenshotPath = captureResult.save_path || screenshotPath;
      return {
        ...ctx,
        [params.export_as || 'screenshot_path']: captureResult.save_path || screenshotPath,
        screenshot_path: captureResult.save_path || screenshotPath,
        screenshot_display_index: displaySelection.display_index,
        screenshot_display_name: displaySelection.display_name,
        screenshot_display_selection_source: displaySelection.selection_source,
        screenshot_application: application || undefined,
        screenshot_window_title: windowTitle || undefined,
        screenshot_window_selection_source: windowTitle
          ? 'window_title'
          : application
            ? 'application'
            : 'display',
        screenshot_window_candidates: windowCandidates || [],
      };
    }
    case 'window_list': {
      const application =
        typeof params.application === 'string' && params.application.trim()
          ? params.application.trim()
          : '';
      if (!application) {
        throw new Error('window_list requires application param');
      }
      return { ...ctx, [params.export_as || 'window_list']: getWindowList(application) };
    }
    case 'chrome_tab_list': {
      const browser =
        typeof params.application === 'string' && params.application.trim()
          ? params.application.trim()
          : 'Google Chrome';
      return { ...ctx, [params.export_as || 'chrome_tab_list']: listChromeTabs(browser) };
    }
    case 'clipboard_read':
      return { ...ctx, [params.export_as || 'clipboard']: clipboardRead() };
    case 'get_focused_input':
      return { ...ctx, [params.export_as || 'focused_input']: detectFocusedInput() };
    case 'get_screen_size':
      return { ...ctx, [params.export_as || 'screen_size']: getScreenSize() };
    case 'window_list': {
      const application =
        typeof params.application === 'string' && params.application.trim()
          ? params.application.trim()
          : '';
      if (!application) {
        throw new Error('window_list requires application param');
      }
      return { ...ctx, [params.export_as || 'window_list']: getWindowList(application) };
    }
    case 'chrome_tab_list': {
      const browser =
        typeof params.application === 'string' && params.application.trim()
          ? params.application.trim()
          : 'Google Chrome';
      return { ...ctx, [params.export_as || 'chrome_tab_list']: listChromeTabs(browser) };
    }
    case 'test_screen_stream': {
      const displaySelection = await systemDisplayHelpers.resolveScreenDisplaySelection(
        params,
        resolve
      );
      const bridge = createScreenCaptureBridge();
      const bus = new StubVideoFrameBus();
      await bridge.pipeTo(bus, {
        max_frames: Math.max(1, Number(params.max_frames || 2)),
        frame_interval_ms: Math.max(0, Number(params.frame_interval_ms || 250)),
        display_index: displaySelection.display_index,
        display_name: displaySelection.display_name,
      } as any);
      const frames: any[] = [];
      for await (const frame of bus.frameStream()) {
        frames.push(frame);
        if (frames.length >= Math.max(1, Number(params.max_frames || 2))) {
          break;
        }
      }
      await bus.close();
      return {
        ...ctx,
        [params.export_as || 'screen_stream_test']: {
          bridge_id: bridge.bridge_id,
          backend: 'stub',
          selected_display_index: displaySelection.display_index,
          selected_display_name: displaySelection.display_name,
          display_selection_source: displaySelection.selection_source,
          frame_count: frames.length,
          frames,
        },
      };
    }
    case 'test_screen_mp4_roundtrip': {
      const displaySelection = await systemDisplayHelpers.resolveScreenDisplaySelection(
        params,
        resolve
      );
      const bridge = createScreenCaptureBridge();
      const captureBus = new StubVideoFrameBus();
      await bridge.pipeTo(captureBus, {
        max_frames: Math.max(1, Number(params.max_frames || 2)),
        frame_interval_ms: Math.max(0, Number(params.frame_interval_ms || 250)),
        display_index: displaySelection.display_index,
        display_name: displaySelection.display_name,
      } as any);
      const outputPath = pathResolver.shared(`runtime/computer/screen-roundtrip-${Date.now()}.mp4`);
      await captureBus.close();
      const exported = await writeVideoFrameBusToMp4(captureBus, outputPath, {
        fps: Math.max(1, Math.round(1000 / Math.max(1, Number(params.frame_interval_ms || 250)))),
      });
      const importBus = new StubVideoFrameBus();
      await pipeMp4ToVideoFrameBus(exported.output_path, importBus);
      await importBus.close();
      return {
        ...ctx,
        [params.export_as || 'screen_roundtrip']: {
          bridge_id: bridge.bridge_id,
          selected_display_index: displaySelection.display_index,
          selected_display_name: displaySelection.display_name,
          display_selection_source: displaySelection.selection_source,
          output_path: exported.output_path,
          exported_frame_count: exported.frame_count,
          imported_frame_count: exported.frame_count,
        },
      };
    }
    case 'shell':
      assertUnsafeShellAllowed();
      return {
        ...ctx,
        [params.export_as || 'last_capture']: await retry(
          async () =>
            safeExec(process.env.SHELL || '/bin/zsh', ['-lc', resolve(params.cmd)], {
              cwd: rootDir,
              env: params.env || {},
            }).trim(),
          buildRetryOptions(params.retry)
        ),
      };
    case 'cli_health_check': {
      const command = resolve(params.command);
      const args = params.args ? params.args.map((a: any) => resolve(a)) : ['--version'];
      const result = await retry(
        async () => safeExecResult(command, args, { timeoutMs: params.timeout_ms || 5000 }),
        buildRetryOptions(params.retry)
      );
      return {
        ...ctx,
        [params.export_as || 'cli_health']: {
          available: result.status === 0,
          stdout: result.stdout.trim(),
          stderr: result.stderr.trim(),
          status: result.status,
        },
      };
    }
    case 'exec': {
      assertUnsafeShellAllowed();
      const command = resolve(params.command);
      const args = params.args ? params.args.map((a: any) => resolve(a)) : [];
      const env = params.env ? params.env : {};
      const result = await retry(
        async () =>
          safeExecResult(command, args, {
            cwd: params.cwd ? path.resolve(rootDir, resolve(params.cwd)) : rootDir,
            env,
            timeoutMs: params.timeout_ms || 30000,
            input: params.input ? resolve(params.input) : undefined,
          }),
        buildRetryOptions(params.retry)
      );
      if (result.status !== 0 && !params.allow_error) {
        throw new Error(`CLI execution failed with status ${result.status}: ${result.stderr}`);
      }
      return {
        ...ctx,
        [params.export_as || 'last_exec']: {
          stdout: result.stdout.trim(),
          stderr: result.stderr.trim(),
          status: result.status,
        },
      };
    }
    case 'read_file':
      return promoteDelegatedCapture(
        await delegateToFilePipeline(
          {
            type: 'capture',
            op: 'read_file',
            params: { ...params, path: resolve(params.path) },
          },
          ctx
        ),
        params,
        'last_capture'
      );
    case 'read_json':
      return {
        ...ctx,
        [params.export_as || 'last_capture_data']: JSON.parse(
          safeReadFile(pathResolver.rootResolve(resolve(params.path)), {
            encoding: 'utf8',
          }) as string
        ),
      };
    case 'probe': {
      const targetPath = pathResolver.rootResolve(resolve(params.path));
      let exists = false;
      let kind = 'unknown';
      try {
        exists = await retry(
          async () => safeExistsSync(targetPath),
          buildRetryOptions(params.retry)
        );
        if (exists) {
          const { safeStat } = await import('@agent/core/secure-io');
          const stats = await retry(
            async () => safeStat(targetPath),
            buildRetryOptions(params.retry)
          );
          kind = stats.isDirectory() ? 'dir' : 'file';
        }
      } catch {
        exists = false;
      }
      return {
        ...ctx,
        [params.export_as || 'last_probe']: {
          path: resolve(params.path),
          exists,
          kind,
        },
      };
    }
    case 'glob_files':
      return {
        ...ctx,
        [params.export_as || 'file_list']: getAllFiles(
          pathResolver.rootResolve(resolve(params.dir))
        )
          .filter((f) => !params.ext || f.endsWith(params.ext))
          .map((f) => path.relative(pathResolver.rootDir(), f)),
      };
    case 'scan_directory': {
      const {
        safeStat,
        safeReaddir,
        safeExistsSync: scanExists,
      } = await import('@agent/core/secure-io');
      const scanRoot = pathResolver.rootResolve(resolve(params.path || '.'));
      if (!scanExists(scanRoot)) {
        return {
          ...ctx,
          [params.export_as || 'scan_result']: {
            files: [],
            count: 0,
            dir: resolve(params.path || '.'),
          },
        };
      }
      const recursive = params.recursive !== false;
      const includeMetadata = params.include_metadata === true;
      const excludePatterns: string[] = Array.isArray(params.exclude)
        ? params.exclude
        : params.exclude
          ? [params.exclude]
          : [];
      const patternStr: string | undefined = params.pattern ? String(params.pattern) : undefined;
      const patternRe = patternStr ? new RegExp(patternStr) : undefined;
      const maxDepth = typeof params.max_depth === 'number' ? params.max_depth : Infinity;

      const isExcluded = (rel: string): boolean =>
        excludePatterns.some(
          (p) => rel.includes(p) || rel.split(path.sep).some((seg) => seg === p)
        );

      const scanDir = (dir: string, depth: number): any[] => {
        if (depth > maxDepth) return [];
        let entries: string[];
        try {
          entries = safeReaddir(dir);
        } catch {
          return [];
        }
        const results: any[] = [];
        for (const entry of entries) {
          if (entry.startsWith('.')) continue;
          const abs = path.join(dir, entry);
          const rel = path.relative(pathResolver.rootDir(), abs);
          if (isExcluded(rel)) continue;
          let stats: ReturnType<typeof safeStat> | null = null;
          try {
            stats = safeStat(abs);
          } catch {
            continue;
          }
          if (stats.isDirectory()) {
            if (recursive) results.push(...scanDir(abs, depth + 1));
          } else {
            if (patternRe && !patternRe.test(rel)) continue;
            const entry_result: any = { path: rel };
            if (includeMetadata) {
              entry_result.size = stats.size;
              entry_result.mtime = stats.mtimeMs;
            }
            results.push(entry_result);
          }
        }
        return results;
      };

      const files = scanDir(scanRoot, 0);
      const data = { files, count: files.length, dir: resolve(params.path || '.') };
      return { ...ctx, [params.export_as || 'scan_result']: data };
    }
    case 'vision_consult':
      return {
        ...ctx,
        [params.export_as || 'vision_decision']: await retry(
          async () => visionJudge.consultVision(resolve(params.context), params.tie_break_options),
          buildRetryOptions(params.retry)
        ),
      };
    case 'pulse_status': {
      const { ledger } = await import('@agent/core');
      return { ...ctx, [params.export_as || 'ledger_valid']: ledger.verifyIntegrity() };
    }
    case 'list_missions': {
      const missionRoot = pathResolver.rootResolve('active/missions');
      const tiers = ['personal', 'confidential', 'public'];
      const requestedStatus =
        typeof params.status === 'string' && params.status.trim()
          ? params.status.trim()
          : undefined;
      const allMissions: any[] = [];
      for (const tier of tiers) {
        const tierPath = path.join(missionRoot, tier);
        if (safeExistsSync(tierPath)) {
          const { safeReaddir } = await import('@agent/core/secure-io');
          const missions = safeReaddir(tierPath);
          for (const missionId of missions.filter((m) => !m.startsWith('.'))) {
            const missionPath = path.join(tierPath, missionId);
            const statePath = path.join(missionPath, 'mission-state.json');
            let state: any = null;
            if (safeExistsSync(statePath)) {
              try {
                state = JSON.parse(safeReadFile(statePath, { encoding: 'utf8' }) as string);
              } catch (err) {
                logger.warn(`[system-pipeline-helpers] suppressed error in scanDir: ${err}`);
              }
            }
            if (requestedStatus && state?.status !== requestedStatus) continue;
            allMissions.push({
              id: missionId,
              tier,
              status: state?.status || 'unknown',
              path: path.relative(pathResolver.rootDir(), missionPath),
              metadata: state || {},
            });
          }
        }
      }
      const data = { status: 'ok', mission_list: allMissions, count: allMissions.length };
      return { ...ctx, [params.export_as || 'mission_list_data']: data };
    }
    case 'list_projects': {
      const { listProjectRecords } = await import('@agent/core');
      const projects = listProjectRecords();
      const data = { status: 'ok', project_list: projects, count: projects.length };
      return { ...ctx, [params.export_as || 'project_list_data']: data };
    }
    case 'list_capabilities': {
      const actuatorRoot = pathResolver.rootResolve('libs/actuators');
      const { safeReaddir } = await import('@agent/core/secure-io');
      const capabilities: any[] = [];
      if (safeExistsSync(actuatorRoot)) {
        const entries = safeReaddir(actuatorRoot);
        for (const entry of entries) {
          const actuatorPath = path.join(actuatorRoot, entry);
          const pkgPath = path.join(actuatorPath, 'package.json');
          if (safeExistsSync(pkgPath)) {
            try {
              const pkg = JSON.parse(safeReadFile(pkgPath, { encoding: 'utf8' }) as string);
              capabilities.push({
                id: entry,
                name: pkg.name,
                description: pkg.description,
                version: pkg.version,
              });
            } catch (err) {
              logger.warn(`[system-pipeline-helpers] suppressed error in scanDir: ${err}`);
            }
          }
        }
      }
      const data = { status: 'ok', capability_list: capabilities, count: capabilities.length };
      return { ...ctx, [params.export_as || 'capability_list_data']: data };
    }
    case 'list_tool_runtimes': {
      const inventory = listToolRuntimeInventory(
        typeof params.requested_mode === 'string' ? (params.requested_mode as any) : 'trial'
      );
      return {
        ...ctx,
        [params.export_as || 'tool_runtimes']: {
          version: inventory.version,
          platform: inventory.platform,
          requested_mode: inventory.requested_mode,
          default_tool_id: inventory.default_tool_id,
          tools: inventory.items.map((item) => ({
            tool_id: item.tool.tool_id,
            display_name: item.tool.display_name,
            ecosystem: item.tool.ecosystem,
            lifecycle_stage: item.lifecycle_stage,
            selected_action: item.selected_action,
            selected_backend: item.selected_backend,
            installed: item.installed,
            requires_install: item.requires_install,
            managed_env_path: item.managed_env_path,
            available_commands: item.available_commands,
            reason: item.reason,
          })),
        },
      };
    }
    case 'list_service_runtimes': {
      const inventory = await listServiceRuntimeInventory(
        typeof params.requested_mode === 'string' ? (params.requested_mode as any) : 'trial'
      );
      return {
        ...ctx,
        [params.export_as || 'service_runtimes']: {
          version: inventory.version,
          platform: inventory.platform,
          requested_mode: inventory.requested_mode,
          default_service_id: inventory.default_service_id,
          services: inventory.items.map((item) => ({
            service_id: item.service.service_id,
            display_name: item.service.display_name,
            kind: item.service.kind,
            lifecycle_stage: item.lifecycle_stage,
            selected_action: item.selected_action,
            available: item.available,
            installed: item.installed,
            requires_install: item.requires_install,
            managed_service_path: item.managed_service_path,
            service_endpoint_path: item.service.service_endpoint_path,
            service_preset_path: item.service.service_preset_path,
            base_url: item.base_url,
            probe_url: item.probe_url,
            reason: item.reason,
          })),
        },
      };
    }
    case 'list_incidents':
    case 'list_knowledge': {
      const incidentRoot = pathResolver.rootResolve('knowledge/product/incidents');
      const { safeReaddir: readIncidentDir } = await import('@agent/core/secure-io');
      const incidents: any[] = [];
      if (safeExistsSync(incidentRoot)) {
        const entries = readIncidentDir(incidentRoot);
        for (const entry of entries.filter((e) => e.endsWith('.md'))) {
          incidents.push({
            id: entry.replace(/\.md$/, ''),
            path: path.join('knowledge/product/incidents', entry),
          });
        }
      }
      const data = { status: 'ok', incident_list: incidents, count: incidents.length };
      return { ...ctx, [params.export_as || 'incident_list_data']: data };
    }
    case 'collect_artifacts': {
      const missionRoot = path.resolve(process.cwd(), 'active/missions');
      const isPathWithin = (basePath: string, targetPath: string): boolean => {
        const relative = path.relative(basePath, targetPath);
        return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
      };
      const missionObjectToRelPath = (m: any): string =>
        typeof m?.path === 'string'
          ? path.relative(missionRoot, path.resolve(process.cwd(), m.path))
          : `${m?.tier ?? 'confidential'}/${m?.id ?? ''}`;

      const resolveList = (value: unknown): string[] => {
        const input = Array.isArray(value) ? value : [value];
        return input.flatMap((item) => {
          if (typeof item !== 'string') {
            if (
              item &&
              typeof item === 'object' &&
              ('id' in (item as object) || 'path' in (item as object))
            ) {
              return [missionObjectToRelPath(item)];
            }
            return [];
          }
          const resolved = resolveVars(item, {});
          if (
            resolved &&
            typeof resolved === 'object' &&
            !Array.isArray(resolved) &&
            'mission_list' in resolved
          ) {
            return ((resolved as any).mission_list as any[]).map(missionObjectToRelPath);
          }
          if (Array.isArray(resolved)) {
            return resolved.flatMap((entry) => {
              if (typeof entry === 'string') return [entry];
              if (entry && typeof entry === 'object' && ('id' in entry || 'path' in entry)) {
                return [missionObjectToRelPath(entry)];
              }
              return [];
            });
          }
          if (typeof resolved === 'string') return [resolved];
          return [];
        });
      };
      const missionIds = resolveList(params.mission_ids);
      const patterns = resolveList(params.patterns);
      const results: Record<string, Record<string, string>> = {};
      const globToRegExp = (pattern: string): RegExp => {
        const escaped = pattern
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*/g, '.*')
          .replace(/\?/g, '.');
        return new RegExp(`^${escaped}$`);
      };
      const matchesPattern = (filePath: string, pattern: string): boolean => {
        const normalizedPath = filePath.replace(/\\/g, '/');
        const basename = path.posix.basename(normalizedPath);
        const matcher = globToRegExp(pattern.replace(/\\/g, '/'));
        return matcher.test(normalizedPath) || matcher.test(basename);
      };
      for (const mId of missionIds) {
        const mPath = path.resolve(missionRoot, mId);
        if (isPathWithin(missionRoot, mPath) && safeExistsSync(mPath)) {
          results[mId] = {};
          for (const pattern of patterns) {
            const files = getAllFiles(mPath).filter((f) =>
              matchesPattern(path.relative(mPath, f), pattern)
            );
            for (const f of files) {
              const rel = path.relative(mPath, f);
              results[mId][rel] = safeReadFile(f, { encoding: 'utf8' }) as string;
            }
          }
        }
      }
      return { ...ctx, [params.export_as || 'artifact_collection']: results };
    }
    case 'sample_traces': {
      const missionRoot = path.resolve(process.cwd(), 'active/missions');
      const count = Number(params.count || 5);
      const allTraces: any[] = [];
      const tiers = ['personal', 'confidential', 'public'];
      const { safeReaddir } = await import('@agent/core/secure-io');
      for (const tier of tiers) {
        const tierPath = path.join(missionRoot, tier);
        if (safeExistsSync(tierPath)) {
          const missions = safeReaddir(tierPath);
          for (const m of missions) {
            const tracePath = path.join(tierPath, m, 'trace.json');
            if (safeExistsSync(tracePath)) {
              allTraces.push({ missionId: `${tier}/${m}`, path: tracePath });
            }
          }
        }
      }
      const sampled = allTraces.sort(() => 0.5 - Math.random()).slice(0, count);
      const results = sampled.map((s) => ({
        missionId: s.missionId,
        trace: JSON.parse(safeReadFile(s.path, { encoding: 'utf8' }) as string),
      }));
      return { ...ctx, [params.export_as || 'sampled_traces']: results };
    }
    case 'list_running_apps': {
      const { platform } = await import('@agent/core');
      const apps = await platform.listRunningApps();
      return { ...ctx, [params.export_as || 'running_apps']: apps };
    }
    case 'list_input_devices': {
      const bridge = createVirtualInputDeviceInventoryBridge();
      const probe = await bridge.probe();
      return { ...ctx, [params.export_as || 'input_devices']: probe.inventory };
    }
    case 'list_displays': {
      const bridge = createScreenDisplayInventoryBridge();
      const probe = await bridge.probe();
      return {
        ...ctx,
        [params.export_as || 'display_inventory']: {
          inventory: probe.inventory,
          primary_display: Array.isArray(probe.inventory.displays)
            ? probe.inventory.displays.find((display) => display.primary) ||
              probe.inventory.displays[0] ||
              null
            : null,
          display_count: Array.isArray(probe.inventory.displays)
            ? probe.inventory.displays.length
            : 0,
        },
      };
    }
    case 'list_media_devices': {
      const bridge = createVirtualMediaDeviceControlBridge();
      const probe = await bridge.probe();
      return {
        ...ctx,
        [params.export_as || 'media_devices']: {
          ...probe.selection,
          supported_actions: probe.supported_actions,
        },
      };
    }
    case 'control_media_devices': {
      const bridge = createVirtualMediaDeviceControlBridge();
      const result = await bridge.control({
        action: typeof params.action === 'string' ? params.action : 'select',
        scope: typeof params.scope === 'string' ? params.scope : 'all',
      });
      return { ...ctx, [params.export_as || 'media_control']: result };
    }
    case 'list_audio_output_devices': {
      const bridge = createVirtualAudioOutputPlaybackBridge();
      const result = await bridge.playOnOutputs(params.targets);
      return { ...ctx, [params.export_as || 'audio_output_devices']: result };
    }
    case 'list_audio_input_devices': {
      const bridge = createVirtualAudioInputRecordingBridge();
      const result = await bridge.recordOnInputs(params.targets);
      return { ...ctx, [params.export_as || 'audio_input_devices']: result };
    }
    case 'camera_capture': {
      const bridge = createVirtualCameraBridge();
      const probe = await bridge.probe();
      return { ...ctx, [params.export_as || 'camera_capture']: probe };
    }
    case 'camera_injection': {
      const bridge = createVirtualCameraInjectionBridge();
      const probe = await bridge.probe();
      return { ...ctx, [params.export_as || 'camera_injection']: probe };
    }
    case 'screen_capture': {
      const bridge = createScreenCaptureBridge();
      const probe = await bridge.probe();
      return { ...ctx, [params.export_as || 'screen_capture']: probe };
    }
    case 'screen_recording': {
      const bridge = createScreenRecordingBridge();
      const probe = await bridge.probe();
      return { ...ctx, [params.export_as || 'screen_recording']: probe };
    }
    case 'test_audio_outputs': {
      const bridge = createVirtualAudioOutputPlaybackBridge();
      const result = await bridge.playOnOutputs(params.targets);
      return { ...ctx, [params.export_as || 'audio_test']: result };
    }
    case 'test_audio_inputs': {
      const bridge = createVirtualAudioInputRecordingBridge();
      const result = await bridge.recordOnInputs(params.targets);
      return { ...ctx, [params.export_as || 'audio_input_test']: result };
    }
    case 'test_camera_stream': {
      const bridge = createVirtualCameraBridge();
      const bus = new StubVideoFrameBus();
      await bridge.pipeTo(bus, {
        max_frames: Math.max(1, Number(params.frame_count || 2)),
        frame_interval_ms: Math.max(0, Number(params.frame_interval_ms || 250)),
        camera_intent: 'record',
        subject_hint: typeof params.subject_hint === 'string' ? params.subject_hint : undefined,
      });
      const frames: any[] = [];
      for await (const frame of bus.frameStream()) {
        frames.push(frame);
        if (frames.length >= Math.max(1, Number(params.frame_count || 2))) {
          break;
        }
      }
      await bus.close();
      const probe = await bridge.probe();
      return {
        ...ctx,
        [params.export_as || 'camera_stream_test']: {
          bridge_id: bridge.bridge_id,
          backend: probe.backend || 'stub',
          selected_camera: probe.selected_camera,
          frame_count: frames.length,
          frames,
        },
      };
    }
    case 'test_camera_mp4_roundtrip': {
      const bridge = createVirtualCameraBridge();
      const captureBus = new StubVideoFrameBus();
      await bridge.pipeTo(captureBus, {
        max_frames: Math.max(1, Number(params.frame_count || 2)),
        frame_interval_ms: Math.max(0, Number(params.frame_interval_ms || 250)),
        camera_intent: 'record',
        subject_hint: typeof params.subject_hint === 'string' ? params.subject_hint : undefined,
      });
      const outputPath = pathResolver.shared(`runtime/computer/camera-roundtrip-${Date.now()}.mp4`);
      await captureBus.close();
      const exported = await writeVideoFrameBusToMp4(captureBus, outputPath, {
        fps: Math.max(1, Math.round(1000 / Math.max(1, Number(params.frame_interval_ms || 250)))),
      });
      const importBus = new StubVideoFrameBus();
      await pipeMp4ToVideoFrameBus(exported.output_path, importBus);
      await importBus.close();
      const probe = await bridge.probe();
      return {
        ...ctx,
        [params.export_as || 'camera_mp4_roundtrip']: {
          bridge_id: bridge.bridge_id,
          selected_camera: probe.selected_camera,
          exported_mp4_path: exported.output_path,
          exported_frame_count: exported.frame_count,
          imported_frame_count: exported.frame_count,
        },
      };
    }
    case 'test_camera_injection': {
      const inventoryBridge = createVirtualDeviceInventoryBridge();
      const cameraBridge = createVirtualCameraBridge({
        inventory_bridge: inventoryBridge,
        device_preference:
          typeof params.camera_device_preference === 'string'
            ? params.camera_device_preference
            : typeof params.device_preference === 'string'
              ? params.device_preference
              : undefined,
        preferred_backend:
          typeof params.preferred_camera_backend === 'string'
            ? (params.preferred_camera_backend as any)
            : undefined,
      });
      const injectionBridge = createVirtualCameraInjectionBridge({
        inventory_bridge: inventoryBridge,
        device_preference:
          typeof params.camera_device_preference === 'string'
            ? params.camera_device_preference
            : typeof params.device_preference === 'string'
              ? params.device_preference
              : undefined,
        device_path: typeof params.device_path === 'string' ? params.device_path : undefined,
      });
      const frameCount = Math.max(1, Number(params.frame_count || 3));
      const frameIntervalMs = Math.max(0, Number(params.frame_interval_ms || 250));
      const mp4Path =
        typeof params.input_mp4_path === 'string' && params.input_mp4_path.trim()
          ? pathResolver.rootResolve(params.input_mp4_path.trim())
          : pathResolver.shared(`runtime/computer/video/camera-injection-${Date.now()}.mp4`);
      let sourcePath = mp4Path;
      if (!(typeof params.input_mp4_path === 'string' && params.input_mp4_path.trim())) {
        const captureBus = new StubVideoFrameBus();
        await cameraBridge.pipeTo(captureBus, {
          device_preference: params.camera_device_preference || params.device_preference,
          max_frames: frameCount,
          frame_interval_ms: frameIntervalMs,
          camera_intent: 'record',
          subject_hint: typeof params.subject_hint === 'string' ? params.subject_hint : undefined,
        });
        await captureBus.close();
        const exportResult = await writeVideoFrameBusToMp4(captureBus, mp4Path, {
          fps: Math.max(1, Math.round(1000 / Math.max(1, frameIntervalMs || 250))),
        });
        sourcePath = exportResult.output_path;
      }
      const injectionResult = await injectionBridge.injectFromMp4(sourcePath, {
        source_path: sourcePath,
        device_preference:
          typeof params.camera_device_preference === 'string'
            ? params.camera_device_preference
            : typeof params.device_preference === 'string'
              ? params.device_preference
              : undefined,
        device_path: typeof params.device_path === 'string' ? params.device_path : undefined,
        output_path: typeof params.output_path === 'string' ? params.output_path : undefined,
        fps: Math.max(1, Math.round(1000 / Math.max(1, frameIntervalMs || 250))),
        subject_hint: typeof params.subject_hint === 'string' ? params.subject_hint : undefined,
      });
      return {
        ...ctx,
        [params.export_as || 'camera_injection_test']: injectionResult,
      };
    }
    case 'resolve_path': {
      // Pure (no-I/O) path resolution so pipelines/ADF never embed a machine-specific
      // prefix. Modes mirror pathResolver: `resolve`/domain helpers expand a portable
      // input to a machine-local absolute path (runtime use only); `to_relative`/`normalize`
      // collapse an absolute path back to a portable repo-relative path (safe to persist).
      const mode = typeof params.mode === 'string' ? params.mode.trim() : 'resolve';
      const input = params.path !== undefined ? String(resolve(params.path)) : '';
      let result: unknown;
      switch (mode) {
        case 'resolve':
          result = pathResolver.resolve(input);
          break;
        case 'to_relative':
          result = pathResolver.toRepoRelative(input);
          break;
        case 'normalize':
          result = pathResolver.normalizeStoredPath(input);
          break;
        case 'shared':
          result = pathResolver.shared(input);
          break;
        case 'knowledge':
          result = pathResolver.knowledge(input);
          break;
        case 'active':
          result = pathResolver.active(input);
          break;
        case 'tmp':
          result = pathResolver.shared(input ? `tmp/${input}` : 'tmp');
          break;
        case 'vault':
          result = pathResolver.vault(input);
          break;
        default:
          throw new Error(
            `resolve_path: unsupported mode "${mode}" (expected resolve|to_relative|normalize|shared|knowledge|active|tmp|vault)`
          );
      }
      return { ...ctx, [params.export_as || 'resolved_path']: result };
    }
    default:
      throw new Error(`Unsupported capture operator in System-Actuator: ${op}`);
  }
}

async function opTransform(op: string, params: any, ctx: any, resolve: (value: any) => any) {
  switch (op) {
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
      const { sre } = await import('@agent/core');
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
      const { say } = await import('@agent/core');
      await say(resolve(params.text || '{{last_capture}}'));
      break;
    case 'native_tts_speak': {
      const text = String(resolve(params.text || '{{last_capture}}'));
      const result = await retry(
        async () =>
          nativeTtsSpeak(text, {
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
      const status = await probeNativeTts();
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
      const platform = process.platform;
      try {
        if (platform === 'darwin') {
          await retry(
            async () => safeExec('open', [url], { cwd: rootDir }),
            buildRetryOptions(params.retry)
          );
        } else if (platform === 'win32') {
          await retry(
            async () => safeExec('cmd', ['/c', 'start', '', url], { cwd: rootDir }),
            buildRetryOptions(params.retry)
          );
        } else {
          await retry(
            async () => safeExec('xdg-open', [url], { cwd: rootDir }),
            buildRetryOptions(params.retry)
          );
        }
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
        | 'up'
        | 'down'
        | 'left'
        | 'right';
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
      const absPath = pathResolver.rootResolve(filePath);
      const rel = path.relative(rootDir, absPath);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new Error(`open_file: path must be within repo root: ${filePath}`);
      }
      const platform = process.platform;
      if (platform === 'darwin') {
        await retry(
          async () => safeExec('open', [absPath], { cwd: rootDir }),
          buildRetryOptions(params.retry)
        );
      } else if (platform === 'win32') {
        await retry(
          async () => safeExec('cmd', ['/c', 'start', '', absPath], { cwd: rootDir }),
          buildRetryOptions(params.retry)
        );
      } else {
        await retry(
          async () => safeExec('xdg-open', [absPath], { cwd: rootDir }),
          buildRetryOptions(params.retry)
        );
      }
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
// (executeAdfSteps). Nested control failures now propagate instead of being
// silently absorbed (AR-06 no-silent-failure).
async function executePipeline(steps: PipelineStep[], initialCtx: any = {}, options: any = {}) {
  const rootDir = pathResolver.rootDir();
  const MAX_STEPS = options.max_steps || DEFAULT_MAX_PIPELINE_STEPS;
  const TIMEOUT = options.timeout_ms || DEFAULT_PIPELINE_TIMEOUT_MS;

  let ctx = { ...initialCtx, timestamp: new Date().toISOString() };

  if (initialCtx.context_path && safeExistsSync(path.resolve(rootDir, initialCtx.context_path))) {
    const saved = JSON.parse(
      safeReadFile(path.resolve(rootDir, initialCtx.context_path), { encoding: 'utf8' }) as string
    );
    ctx = { ...ctx, ...saved };
  }

  const result = await executeAdfSteps(
    steps as Parameters<typeof executeAdfSteps>[0],
    ctx,
    { maxSteps: MAX_STEPS, timeoutMs: TIMEOUT },
    {
      capture: opCapture,
      transform: opTransform,
      apply: opApply,
      control: opControl,
    }
  );
  ctx = result.context;

  if (initialCtx.context_path) {
    safeWriteFile(path.resolve(rootDir, initialCtx.context_path), JSON.stringify(ctx, null, 2));
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
