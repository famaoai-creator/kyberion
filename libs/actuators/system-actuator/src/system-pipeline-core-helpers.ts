/** Shared guards and control/display helpers for the system pipeline actuator. */

import { logger } from '@agent/core/core';
import type { AdfRunResult, AdfStep } from '@agent/core/pipeline/adf-engine';
import { stripAuthorityEnvOverrides } from '@agent/core/authority';
import {
  assertSafeRepositoryPath,
  safeReadFile,
  safeMkdir,
  resolveUserLoginShell,
  safeExecResult,
  safeExecShellScript,
  safeExistsSync,
  safeLstat,
  safeStat,
} from '@agent/core/secure-io';
import { assertVolatileId, pathResolver } from '@agent/core/path-resolver';
import { resolveVars, evaluateCondition } from '@agent/core/logic-utils';

import { resolveActiveProfileRoot } from '@agent/core/profile-root';
import { retry } from '@agent/core/async-utils';
import { createVirtualMediaDeviceControlBridge } from '@agent/core/virtual/virtual-media-device-control-bridge';
import { createVirtualAudioOutputPlaybackBridge } from '@agent/core/virtual/virtual-audio-output-playback-bridge';
import { createVirtualAudioInputRecordingBridge } from '@agent/core/virtual/virtual-audio-input-recording-bridge';
import { createVirtualInputDeviceInventoryBridge } from '@agent/core/virtual/virtual-input-device-inventory-bridge';
import { createScreenCaptureBridge } from '@agent/core/virtual/screen-capture-bridge';
import { createScreenRecordingBridge } from '@agent/core/virtual/screen-recording-bridge';
import {
  redactScreenVideoFrame,
  redactScreenCaptureFile,
} from '@agent/core/virtual/screen-frame-redaction';
import { createScreenDisplayInventoryBridge } from '@agent/core/virtual/screen-display-inventory-bridge';
import { listToolRuntimeInventory } from '@agent/core/tool/tool-runtime-registry';
import { listServiceRuntimeInventory } from '@agent/core/service/service-runtime-registry';
import { probeSileroVad } from '@agent/core/silero-vad-bridge';
import { buildUnknownActuatorOpError } from '@agent/core/actuator/actuator-op-registry';
import { defineActuatorPipelineBase } from '@agent/core/actuator/actuator-sdk';
import type {
  ScreenDisplayInventory,
  ScreenDisplayRecord,
} from '@agent/core/virtual/screen-display-inventory-bridge';
import { StubVideoFrameBus } from '@agent/core/video/video-frame-bus';
import {
  writeVideoFramesToMp4,
  pipeMp4ToVideoFrameBus,
} from '@agent/core/video/video-frame-archive';
import type { VideoFrame } from '@agent/core/meeting/meeting-session-types';
import {
  runRecordAudioOp,
  runCapturePhotoOp,
  runRecordCameraOp,
  runCameraCaptureProbe,
  runCameraInjectionProbe,
  runTestCameraStreamOp,
  runTestCameraMp4RoundtripOp,
  runTestCameraInjectionOp,
  replayCollectedFrames,
} from './system-pipeline-capture-media-helpers.js';
import { withinLoopBounds, DEFAULT_MAX_LOOP_ITERATIONS } from '@agent/core/execution-bounds';
import {
  reconcileConfigFallbacks,
  reconcileUnclassifiedErrors,
  reconcileUnhandledIntents,
} from '@agent/core/reconcile-ops';
import { buildCostReportFromHistory } from '@agent/core/cost-report';
import {
  collectAuditVerifyReport,
  runMemoryPromotionQueueSummary,
  runTaskModelRoutingSummary,
} from '@agent/core/report-ops';
import { macosAutomationBridge } from '@agent/core/macos-automation-bridge';
import { getRegisteredEnvText, parseSafeJsonObjectValue, readJson } from '@agent/core/foundation';
import { loadStateAtPath } from '@agent/core/mission/mission-state';
import { handleAction as handleFileAction } from '../../file-actuator/src/file-pipeline-helpers.js';
import { getAllFiles } from '@agent/core/fs-utils';
import { runBaselineCheck } from '../../../../scripts/run_baseline_check.js';
import {
  activateApplication,
  detectFocusedInput,
  activateWindowByTitle,
  getScreenSize,
  getWindowList,
  clipboardRead,
  listChromeTabs,
} from '@agent/core/virtual/os-automation';
import type { FocusedInputState } from '@agent/core/virtual/os-automation';
import { validateOpInput } from '@agent/core/pipeline/op-input-contracts';
import {
  systemDisplayHelpers,
  type ResolvedScreenDisplaySelection,
} from './system-display-helpers.js';
import { systemFocusHelpers } from './system-focus-helpers.js';
import * as visionJudge from '@agent/shared-vision';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

function resolveSystemPath(ref: string, allowMissingLeaf = true, allowSymlinkLeaf = false): string {
  return assertSafeRepositoryPath(pathResolver.rootResolve(ref), {
    allowMissingLeaf,
    allowSymlinkLeaf,
  });
}

function isExistingRegularFile(filePath: string): boolean {
  if (!safeExistsSync(filePath)) return false;
  try {
    return safeLstat(filePath).isFile();
  } catch {
    return false;
  }
}

function readSystemJson(filePath: string, label: string): unknown {
  if (!isExistingRegularFile(filePath)) {
    throw new Error(`${label} must be an existing regular file: ${filePath}`);
  }
  return readJson(filePath);
}

export const COMPUTER_RUNTIME_DIR = pathResolver.shared('runtime/computer');
export const SYSTEM_MANIFEST_PATH = pathResolver.rootResolve(
  'libs/actuators/system-actuator/manifest.json'
);
export const DEFAULT_SYSTEM_RETRY = {
  maxRetries: 2,
  initialDelayMs: 250,
  maxDelayMs: 2000,
  factor: 2,
  jitter: true,
};

/**
 * Scratch dir for raw screen frames awaiting redaction: inside the running
 * mission (MISSION_ID) so raw pixels stay in its scope, else undefined (the
 * redactor's shared tmp default). An invalid or unknown mission id falls back.
 */
export function screenRedactionWorkDir(
  missionId: string | undefined = getRegisteredEnvText('MISSION_ID'),
  findMissionPath: (id: string) => string | null = pathResolver.findMissionPath
): string | undefined {
  const raw = (missionId || '').trim();
  if (!raw) return undefined;
  let id: string;
  try {
    id = assertVolatileId('mission', raw);
  } catch {
    return undefined;
  }
  const missionPath = findMissionPath(id);
  return missionPath ? path.join(missionPath, 'tmp', 'screen-redaction') : undefined;
}

function redactFrameInScope(workDir: string | undefined) {
  return (frame: Parameters<typeof redactScreenVideoFrame>[0]) =>
    redactScreenVideoFrame(frame, workDir ? { work_dir: workDir } : {});
}

export async function writeRedactedScreenFrames(
  bridge: ReturnType<typeof createScreenCaptureBridge>,
  bus: StubVideoFrameBus,
  input: Record<string, unknown>,
  workDir: string | undefined = screenRedactionWorkDir()
): Promise<void> {
  const redact = redactFrameInScope(workDir);
  const redactingBus = {
    writeFrames: async (stream: AsyncIterable<any>) =>
      bus.writeFrames(
        (async function* () {
          for await (const frame of stream) {
            const redacted = await redact(frame);
            if (!redacted || redacted.payload.byteLength === 0) {
              throw new Error('screen frame withheld: redaction_failed');
            }
            yield redacted;
          }
        })()
      ),
  };
  await bridge.pipeTo(redactingBus as never, input);
}
export async function opCapture(
  op: string,
  params: Record<string, unknown>,
  ctx: Record<string, unknown>,
  resolve: (value: unknown) => unknown
) {
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
      let captureMode: 'screen' | 'focused_window' =
        params.capture_mode === 'focused_window' ? 'focused_window' : 'screen';
      const screenshotPath = resolveCanonicalScreenCapturePath(params, resolve);
      const rawScreenshotPath = pathResolver.shared(
        path.join('tmp', 'screen-captures', `raw-${randomUUID()}.png`)
      );
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
        activateWindowByTitle(
          application || 'Google Chrome',
          windowTitle,
          windowMatchPolicy as 'strict' | 'prefix' | 'contains'
        );
        captureMode = 'focused_window';
      }
      const bridge = createScreenCaptureBridge();
      const captureResult = await bridge.captureScreenshot({
        save_path: rawScreenshotPath,
        display_index: displaySelection.display_index,
        capture_mode: captureMode,
        application: application || undefined,
        window_title: windowTitle || undefined,
        window_match_policy: windowMatchPolicy,
      } as never);
      await redactScreenCaptureFile(captureResult.save_path || rawScreenshotPath, screenshotPath);
      return {
        ...ctx,
        [String(params.export_as ?? 'screenshot_path')]: screenshotPath,
        screenshot_path: screenshotPath,
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
    case 'record_screen': {
      const displaySelection = await systemDisplayHelpers.resolveScreenDisplaySelection(
        params,
        resolve
      );
      const bridge = createScreenRecordingBridge({
        frame_redactor: redactFrameInScope(screenRedactionWorkDir()),
      });
      const probe = await bridge.probe();
      if (!probe.available) {
        throw new Error(
          `record_screen unavailable: ${probe.capture_bridge?.reason || 'screen recording bridge unavailable'}`
        );
      }
      const fpsValue = Number(resolve(params.fps || 30));
      const fps = Number.isFinite(fpsValue) && fpsValue > 0 ? Math.min(120, fpsValue) : 30;
      const intervalValue = Number(resolve(params.frame_interval_ms || 0));
      const frameIntervalMs =
        Number.isFinite(intervalValue) && intervalValue >= 0
          ? intervalValue
          : Math.max(1, Math.round(1000 / fps));
      const durationValue = Number(resolve(params.duration || 0));
      const explicitFrameCount = Number(resolve(params.max_frames || 0));
      const frameCount =
        Number.isInteger(explicitFrameCount) && explicitFrameCount > 0
          ? explicitFrameCount
          : Number.isFinite(durationValue) && durationValue > 0
            ? Math.max(1, Math.ceil(durationValue * fps))
            : 1;
      const outputPath = resolveCanonicalScreenRecordingPath(params);
      const result = await bridge.recordToMp4(outputPath, {
        display_index: displaySelection.display_index,
        capture_mode: params.capture_mode === 'focused_window' ? 'focused_window' : 'screen',
        max_frames: frameCount,
        frame_interval_ms: frameIntervalMs,
        fps,
        cleanup: true,
      });
      return {
        ...ctx,
        [String(params.export_as ?? 'screen_recording')]: {
          ...result,
          status: 'succeeded',
          bridge_id: bridge.bridge_id,
          selected_display_index: displaySelection.display_index,
          selected_display_name: displaySelection.display_name,
          display_selection_source: displaySelection.selection_source,
        },
      };
    }
    case 'record_audio': {
      return runRecordAudioOp(params, ctx, resolve);
    }
    case 'capture_photo': {
      return runCapturePhotoOp(params, ctx, resolve);
    }
    case 'record_camera': {
      return runRecordCameraOp(params, ctx, resolve);
    }
    case 'macos_automation_probe':
      return {
        ...ctx,
        [String(params.export_as ?? 'macos_automation')]: {
          ...macosAutomationBridge.probe(),
          capabilities: macosAutomationBridge.listCapabilities(),
        },
      };
    case 'window_list': {
      const application =
        typeof params.application === 'string' && params.application.trim()
          ? params.application.trim()
          : '';
      if (!application) {
        throw new Error('window_list requires application param');
      }
      return { ...ctx, [String(params.export_as ?? 'window_list')]: getWindowList(application) };
    }
    case 'chrome_tab_list': {
      const browser =
        typeof params.application === 'string' && params.application.trim()
          ? params.application.trim()
          : 'Google Chrome';
      return { ...ctx, [String(params.export_as ?? 'chrome_tab_list')]: listChromeTabs(browser) };
    }
    case 'clipboard_read':
      return { ...ctx, [String(params.export_as ?? 'clipboard')]: clipboardRead() };
    case 'get_focused_input':
      return { ...ctx, [String(params.export_as ?? 'focused_input')]: detectFocusedInput() };
    case 'get_screen_size':
      return { ...ctx, [String(params.export_as ?? 'screen_size')]: getScreenSize() };
    case 'window_list': {
      const application =
        typeof params.application === 'string' && params.application.trim()
          ? params.application.trim()
          : '';
      if (!application) {
        throw new Error('window_list requires application param');
      }
      return { ...ctx, [String(params.export_as ?? 'window_list')]: getWindowList(application) };
    }
    case 'chrome_tab_list': {
      const browser =
        typeof params.application === 'string' && params.application.trim()
          ? params.application.trim()
          : 'Google Chrome';
      return { ...ctx, [String(params.export_as ?? 'chrome_tab_list')]: listChromeTabs(browser) };
    }
    case 'test_screen_stream': {
      const displaySelection = await systemDisplayHelpers.resolveScreenDisplaySelection(
        params,
        resolve
      );
      const bridge = createScreenCaptureBridge();
      const bus = new StubVideoFrameBus();
      await writeRedactedScreenFrames(bridge, bus, {
        max_frames: Math.max(1, Number(params.max_frames || 2)),
        frame_interval_ms: Math.max(0, Number(params.frame_interval_ms || 250)),
        display_index: displaySelection.display_index,
        display_name: displaySelection.display_name,
      } as never);
      const frames: unknown[] = [];
      for await (const frame of bus.frameStream()) {
        frames.push(frame);
        if (frames.length >= Math.max(1, Number(params.max_frames || 2))) {
          break;
        }
      }
      await bus.close();
      return {
        ...ctx,
        [String(params.export_as ?? 'screen_stream_test')]: {
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
      const redact = redactFrameInScope(screenRedactionWorkDir());
      const frames: VideoFrame[] = [];
      for await (const frame of bridge.captureStream({
        max_frames: Math.max(1, Number(params.max_frames || 2)),
        frame_interval_ms: Math.max(0, Number(params.frame_interval_ms || 250)),
        display_index: displaySelection.display_index,
        display_name: displaySelection.display_name,
      } as any)) {
        const redacted = await redact(frame);
        if (!redacted || redacted.payload.byteLength === 0) {
          throw new Error('screen frame withheld: redaction_failed');
        }
        frames.push(redacted);
      }
      const outputPath = pathResolver.shared(`runtime/computer/screen-roundtrip-${Date.now()}.mp4`);
      const exported = await writeVideoFramesToMp4(outputPath, replayCollectedFrames(frames), {
        fps: Math.max(1, Math.round(1000 / Math.max(1, Number(params.frame_interval_ms || 250)))),
      });
      const importBus = new StubVideoFrameBus();
      await pipeMp4ToVideoFrameBus(exported.output_path, importBus);
      // Count re-imported frames (bounded: never wait past the exported
      // count or a diagnostic timeout — an open bus blocks on empty).
      let importedFrameCount = 0;
      const importDeadline = Date.now() + 15_000;
      for await (const frame of importBus.frameStream()) {
        void frame;
        importedFrameCount += 1;
        if (importedFrameCount >= exported.frame_count || Date.now() > importDeadline) break;
      }
      await importBus.close();
      return {
        ...ctx,
        [String(params.export_as ?? 'screen_roundtrip')]: {
          bridge_id: bridge.bridge_id,
          selected_display_index: displaySelection.display_index,
          selected_display_name: displaySelection.display_name,
          display_selection_source: displaySelection.selection_source,
          output_path: exported.output_path,
          exported_frame_count: exported.frame_count,
          imported_frame_count: importedFrameCount,
        },
      };
    }
    case 'shell':
      assertUnsafeShellAllowed();
      return {
        ...ctx,
        [String(params.export_as ?? 'last_capture')]: await retry(
          async () =>
            safeExecShellScript(
              resolveUserLoginShell(getRegisteredEnvText('SHELL'), '/bin/zsh'),
              String(resolve(String(params.cmd))),
              {
                login: true,
                cwd: rootDir,
                env: stripAuthorityEnvOverrides(params.env as Record<string, string> | undefined),
              }
            ).trim(),
          buildRetryOptions(params.retry as Record<string, unknown> | undefined)
        ),
      };
    // LE-03: registry reconcile sweeps as in-process typed ops (formerly
    // `system:shell` wrappers around dist/scripts/reconcile_*.js). Structured
    // results land directly in ctx — no stdout parsing, no silent `|| echo` fallback.
    case 'reconcile_config_fallbacks':
      return {
        ...ctx,
        // B1: proposal-only unless the step explicitly opts into knowledge writes.
        [String(params.export_as ?? 'reconcile_result')]: reconcileConfigFallbacks({
          apply: params.apply === true,
        }),
      };
    case 'reconcile_unclassified_errors':
      return {
        ...ctx,
        [String(params.export_as ?? 'reconcile_result')]: reconcileUnclassifiedErrors(),
      };
    case 'reconcile_unhandled_intents':
      return {
        ...ctx,
        [String(params.export_as ?? 'reconcile_result')]: reconcileUnhandledIntents(),
      };
    // LE-03 rollout batch 2: report/verify sweeps as in-process typed ops
    // (formerly system:shell/system:exec wrappers around dist/scripts/*.js).
    case 'cost_report': {
      const lastDays = Number(params.last_days);
      const since = params.since
        ? String(resolve(params.since))
        : Number.isFinite(lastDays) && lastDays > 0
          ? new Date(Date.now() - lastDays * 24 * 60 * 60 * 1000).toISOString()
          : undefined;
      return {
        ...ctx,
        [String(params.export_as ?? 'cost_report')]: buildCostReportFromHistory({
          since,
          until: params.until ? String(resolve(params.until)) : undefined,
        }),
      };
    }
    case 'audit_verify':
      return {
        ...ctx,
        [String(params.export_as ?? 'audit_report')]: collectAuditVerifyReport({
          since: params.since ? String(resolve(params.since)) : undefined,
          ledgers: Array.isArray(params.ledgers) ? params.ledgers.map(String) : undefined,
        }),
      };
    case 'summarize_memory_promotion_queue':
      return {
        ...ctx,
        [String(params.export_as ?? 'memory_queue_summary')]: runMemoryPromotionQueueSummary({
          status: params.status ? String(resolve(params.status)) : undefined,
          output_path: params.output_path ? String(resolve(params.output_path)) : undefined,
        }),
      };
    case 'summarize_task_model_routing':
      return {
        ...ctx,
        [String(params.export_as ?? 'task_model_routing_summary')]: runTaskModelRoutingSummary({
          task_events_path: params.task_events_path
            ? String(resolve(params.task_events_path))
            : undefined,
          supervisor_events_path: params.supervisor_events_path
            ? String(resolve(params.supervisor_events_path))
            : undefined,
          output_path: params.output_path ? String(resolve(params.output_path)) : undefined,
        }),
      };
    case 'cli_health_check': {
      const command = String(resolve(params.command));
      const args = params.args
        ? (params.args as unknown[]).map((a) => String(resolve(a)))
        : ['--version'];
      const result = await retry(
        async () => safeExecResult(command, args, { timeoutMs: Number(params.timeout_ms) || 5000 }),
        buildRetryOptions(params.retry as Record<string, unknown> | undefined)
      );
      return {
        ...ctx,
        [String(params.export_as ?? 'cli_health')]: {
          available: result.status === 0,
          stdout: result.stdout.trim(),
          stderr: result.stderr.trim(),
          status: result.status,
        },
      };
    }
    case 'exec': {
      assertUnsafeShellAllowed();
      const command = String(resolve(params.command));
      const args = params.args ? (params.args as unknown[]).map((a) => String(resolve(a))) : [];
      // Pipeline-supplied env may not set execution authority (DR-01).
      const env = stripAuthorityEnvOverrides(params.env as Record<string, string> | undefined);
      const result = await retry(
        async () =>
          safeExecResult(command, args, {
            cwd: params.cwd ? resolveSystemPath(String(resolve(params.cwd)), false) : rootDir,
            env,
            timeoutMs: Number(params.timeout_ms) || 30000,
            input: params.input ? String(resolve(params.input)) : undefined,
          }),
        buildRetryOptions(params.retry as Record<string, unknown> | undefined)
      );
      if (result.status !== 0 && !params.allow_error) {
        throw new Error(`CLI execution failed with status ${result.status}: ${result.stderr}`);
      }
      return {
        ...ctx,
        [String(params.export_as ?? 'last_exec')]: {
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
        [String(params.export_as ?? 'last_capture_data')]: readSystemJson(
          resolveSystemPath(String(resolve(params.path))),
          'system read_json input'
        ),
      };
    case 'probe': {
      if (params.capability === 'silero_vad') {
        const status = probeSileroVad();
        return {
          ...ctx,
          [String(params.export_as ?? 'last_probe')]: {
            capability: 'silero_vad',
            available: status.available,
            ...(status.reason ? { reason: status.reason } : {}),
          },
        };
      }
      const targetPath = resolveSystemPath(
        String(resolve(params.path)),
        true,
        params.allow_symlink_leaf === true
      );
      let exists = false;
      let kind = 'unknown';
      try {
        exists = await retry(
          async () => safeExistsSync(targetPath),
          buildRetryOptions(params.retry as Record<string, unknown> | undefined)
        );
        if (exists) {
          const stats = await retry(
            async () => safeStat(targetPath),
            buildRetryOptions(params.retry as Record<string, unknown> | undefined)
          );
          kind = stats.isDirectory() ? 'dir' : 'file';
        }
      } catch {
        exists = false;
      }
      return {
        ...ctx,
        [String(params.export_as ?? 'last_probe')]: {
          path: resolve(params.path),
          exists,
          kind,
        },
      };
    }
    case 'probe_active_profile': {
      const relativePath = String(resolve(params.path || '')).trim();
      if (
        !relativePath ||
        path.isAbsolute(relativePath) ||
        relativePath.split(/[\\/]/).includes('..')
      ) {
        throw new Error('probe_active_profile requires a safe profile-relative path');
      }
      const targetPath = path.join(resolveActiveProfileRoot(), relativePath);
      let exists = false;
      let kind = 'unknown';
      try {
        exists = safeExistsSync(targetPath);
        if (exists) {
          const stats = safeStat(targetPath);
          kind = stats.isDirectory() ? 'dir' : 'file';
        }
      } catch {
        exists = false;
      }
      return {
        ...ctx,
        [String(params.export_as ?? 'last_probe')]: {
          path: relativePath,
          exists,
          kind,
        },
      };
    }
    case 'glob_files':
      return {
        ...ctx,
        [String(params.export_as ?? 'file_list')]: getAllFiles(
          resolveSystemPath(String(resolve(params.dir)))
        )
          .filter((f) => !params.ext || f.endsWith(String(params.ext)))
          .map((f) => path.relative(pathResolver.rootDir(), f)),
      };
    case 'scan_directory': {
      const { safeReaddir, safeExistsSync: scanExists } = await import('@agent/core/secure-io');
      const scanRoot = resolveSystemPath(String(resolve(params.path || '.')));
      if (!scanExists(scanRoot)) {
        return {
          ...ctx,
          [String(params.export_as ?? 'scan_result')]: {
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

      const scanDir = (dir: string, depth: number): Record<string, unknown>[] => {
        if (depth > maxDepth) return [];
        let entries: string[];
        try {
          entries = safeReaddir(dir);
        } catch {
          return [];
        }
        const results: Record<string, unknown>[] = [];
        for (const entry of entries) {
          if (entry.startsWith('.')) continue;
          let abs: string;
          try {
            abs = assertSafeRepositoryPath(path.join(dir, entry));
          } catch {
            continue;
          }
          const rel = path.relative(pathResolver.rootDir(), abs);
          if (isExcluded(rel)) continue;
          let stats: ReturnType<typeof safeLstat> | null = null;
          try {
            stats = safeLstat(abs);
          } catch {
            continue;
          }
          if (stats.isSymbolicLink()) continue;
          if (stats.isDirectory()) {
            if (recursive) results.push(...scanDir(abs, depth + 1));
          } else {
            if (patternRe && !patternRe.test(rel)) continue;
            const entry_result: Record<string, unknown> = { path: rel };
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
      return { ...ctx, [String(params.export_as ?? 'scan_result')]: data };
    }
    case 'vision_consult':
      return {
        ...ctx,
        [String(params.export_as ?? 'vision_decision')]: await retry(
          async () =>
            visionJudge.consultVision(
              resolve(params.context as Record<string, unknown>) as string,
              params.tie_break_options as never
            ),
          buildRetryOptions(params.retry as Record<string, unknown> | undefined)
        ),
      };
    case 'pulse_status': {
      const { ledger } = await import('@agent/core/ledger');
      return { ...ctx, [String(params.export_as ?? 'ledger_valid')]: ledger.verifyIntegrity() };
    }
    case 'baseline_check': {
      const report = await runBaselineCheck();
      return { ...ctx, [String(params.export_as ?? 'baseline_check')]: report };
    }
    case 'list_missions': {
      const missionRoot = resolveSystemPath('active/missions');
      const tiers = ['personal', 'confidential', 'public'];
      const requestedStatus =
        typeof params.status === 'string' && params.status.trim()
          ? params.status.trim()
          : undefined;
      const allMissions: Record<string, unknown>[] = [];
      for (const tier of tiers) {
        const tierPath = path.join(missionRoot, tier);
        if (safeExistsSync(tierPath) && safeLstat(tierPath).isDirectory()) {
          const { safeReaddir } = await import('@agent/core/secure-io');
          const missions = safeReaddir(tierPath);
          for (const missionId of missions.filter((m) => !m.startsWith('.'))) {
            const missionPath = path.join(tierPath, missionId);
            if (!safeLstat(missionPath).isDirectory()) continue;
            const statePath = assertSafeRepositoryPath(
              path.join(missionPath, 'mission-state.json'),
              { allowMissingLeaf: true }
            );
            const state = safeExistsSync(statePath) ? loadStateAtPath(statePath) : null;
            if (!state) continue;
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
      return { ...ctx, [String(params.export_as ?? 'mission_list_data')]: data };
    }
    case 'list_projects': {
      const { listProjectRecords } = await import('@agent/core/project/project-registry');
      const projects = listProjectRecords();
      const data = { status: 'ok', project_list: projects, count: projects.length };
      return { ...ctx, [String(params.export_as ?? 'project_list_data')]: data };
    }
    case 'list_capabilities': {
      const actuatorRoot = pathResolver.rootResolve('libs/actuators');
      const { safeReaddir } = await import('@agent/core/secure-io');
      const capabilities: Record<string, unknown>[] = [];
      if (safeExistsSync(actuatorRoot)) {
        const entries = safeReaddir(actuatorRoot);
        for (const entry of entries) {
          const actuatorPath = path.join(actuatorRoot, entry);
          const pkgPath = path.join(actuatorPath, 'package.json');
          if (safeLstat(actuatorPath).isDirectory() && safeExistsSync(pkgPath)) {
            try {
              const pkg = parseSafeJsonObjectValue(
                readSystemJson(assertSafeRepositoryPath(pkgPath), 'system capability metadata'),
                'system capability metadata'
              );
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
      return { ...ctx, [String(params.export_as ?? 'capability_list_data')]: data };
    }
    case 'list_tool_runtimes': {
      const inventory = listToolRuntimeInventory(
        typeof params.requested_mode === 'string' ? (params.requested_mode as never) : 'trial'
      );
      return {
        ...ctx,
        [String(params.export_as ?? 'tool_runtimes')]: {
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
        typeof params.requested_mode === 'string' ? (params.requested_mode as never) : 'trial'
      );
      return {
        ...ctx,
        [String(params.export_as ?? 'service_runtimes')]: {
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
      const incidents: Record<string, unknown>[] = [];
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
      return { ...ctx, [String(params.export_as ?? 'incident_list_data')]: data };
    }
    case 'collect_artifacts': {
      const missionRoot = path.resolve(process.cwd(), 'active/missions');
      const isPathWithin = (basePath: string, targetPath: string): boolean => {
        const relative = path.relative(basePath, targetPath);
        return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
      };
      const missionObjectToRelPath = (m: Record<string, unknown>): string =>
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
            return (
              (resolved as Record<string, unknown>).mission_list as Record<string, unknown>[]
            ).map(missionObjectToRelPath);
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
        let safeMissionPath: string;
        try {
          safeMissionPath = assertSafeRepositoryPath(mPath, { allowMissingLeaf: true });
        } catch {
          continue;
        }
        if (
          isPathWithin(missionRoot, safeMissionPath) &&
          safeExistsSync(safeMissionPath) &&
          safeLstat(safeMissionPath).isDirectory()
        ) {
          results[mId] = {};
          for (const pattern of patterns) {
            const files = getAllFiles(safeMissionPath).filter((f) =>
              matchesPattern(path.relative(safeMissionPath, f), pattern)
            );
            for (const f of files) {
              const rel = path.relative(safeMissionPath, f);
              results[mId][rel] = safeReadFile(assertSafeRepositoryPath(f), {
                encoding: 'utf8',
              }) as string;
            }
          }
        }
      }
      return { ...ctx, [String(params.export_as ?? 'artifact_collection')]: results };
    }
    case 'sample_traces': {
      const missionRoot = resolveSystemPath('active/missions');
      const count = Number(params.count || 5);
      const allTraces: Record<string, unknown>[] = [];
      const tiers = ['personal', 'confidential', 'public'];
      const { safeReaddir } = await import('@agent/core/secure-io');
      for (const tier of tiers) {
        const tierPath = path.join(missionRoot, tier);
        if (safeExistsSync(tierPath) && safeLstat(tierPath).isDirectory()) {
          const missions = safeReaddir(tierPath);
          for (const m of missions) {
            const tracePath = path.join(tierPath, m, 'trace.json');
            if (
              safeLstat(path.join(tierPath, m)).isDirectory() &&
              safeExistsSync(assertSafeRepositoryPath(tracePath, { allowMissingLeaf: true }))
            ) {
              allTraces.push({
                missionId: `${tier}/${m}`,
                path: assertSafeRepositoryPath(tracePath),
              });
            }
          }
        }
      }
      const sampled = allTraces.sort(() => 0.5 - Math.random()).slice(0, count);
      const results = sampled.map((s) => ({
        missionId: s.missionId,
        trace: readSystemJson(assertSafeRepositoryPath(String(s.path)), 'system mission trace'),
      }));
      return { ...ctx, [String(params.export_as ?? 'sampled_traces')]: results };
    }
    case 'list_running_apps': {
      const { platform } = await import('@agent/core/platform');
      const apps = await platform.listRunningApps();
      return { ...ctx, [String(params.export_as ?? 'running_apps')]: apps };
    }
    case 'list_input_devices': {
      const bridge = createVirtualInputDeviceInventoryBridge();
      const probe = await bridge.probe();
      return { ...ctx, [String(params.export_as ?? 'input_devices')]: probe.inventory };
    }
    case 'list_displays': {
      const bridge = createScreenDisplayInventoryBridge();
      const probe = await bridge.probe();
      return {
        ...ctx,
        [String(params.export_as ?? 'display_inventory')]: {
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
        [String(params.export_as ?? 'media_devices')]: {
          ...probe.selection,
          supported_actions: probe.supported_actions,
        },
      };
    }
    case 'control_media_devices': {
      const bridge = createVirtualMediaDeviceControlBridge();
      const result = await bridge.control({
        action: (typeof params.action === 'string' ? params.action : 'select') as never,
        scope: (typeof params.scope === 'string' ? params.scope : 'all') as never,
      });
      return { ...ctx, [String(params.export_as ?? 'media_control')]: result };
    }
    case 'list_audio_output_devices': {
      const bridge = createVirtualAudioOutputPlaybackBridge();
      const result = await bridge.playOnOutputs(params.targets as string[]);
      return { ...ctx, [String(params.export_as ?? 'audio_output_devices')]: result };
    }
    case 'list_audio_input_devices': {
      const bridge = createVirtualAudioInputRecordingBridge();
      const result = await bridge.recordOnInputs(params.targets as string[]);
      return { ...ctx, [String(params.export_as ?? 'audio_input_devices')]: result };
    }
    case 'camera_capture': {
      return runCameraCaptureProbe(params, ctx);
    }
    case 'camera_injection': {
      return runCameraInjectionProbe(params, ctx);
    }
    case 'screen_capture': {
      const bridge = createScreenCaptureBridge();
      const probe = await bridge.probe();
      return { ...ctx, [String(params.export_as ?? 'screen_capture')]: probe };
    }
    case 'screen_recording': {
      const bridge = createScreenRecordingBridge();
      const probe = await bridge.probe();
      return { ...ctx, [String(params.export_as ?? 'screen_recording')]: probe };
    }
    case 'test_audio_outputs': {
      const bridge = createVirtualAudioOutputPlaybackBridge();
      const result = await bridge.playOnOutputs(params.targets as string[]);
      return { ...ctx, [String(params.export_as ?? 'audio_test')]: result };
    }
    case 'test_audio_inputs': {
      const bridge = createVirtualAudioInputRecordingBridge();
      const result = await bridge.recordOnInputs(params.targets as string[]);
      return { ...ctx, [String(params.export_as ?? 'audio_input_test')]: result };
    }
    case 'test_camera_stream': {
      return runTestCameraStreamOp(params, ctx);
    }
    case 'test_camera_mp4_roundtrip': {
      return runTestCameraMp4RoundtripOp(params, ctx);
    }
    case 'test_camera_injection': {
      return runTestCameraInjectionOp(params, ctx);
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
      return { ...ctx, [String(params.export_as ?? 'resolved_path')]: result };
    }
    default:
      throw new Error(`Unsupported capture operator in System-Actuator: ${op}`);
  }
}

export const warnedSystemOpAliases = new Set<string>();

export interface PipelineStep {
  type: 'capture' | 'transform' | 'apply' | 'control';
  op: string;
  params: Record<string, unknown>;
}

export const {
  buildRetryOptions,
  assertUnsafeShellAllowed,
  gates: { assertUnsafeJsAllowed },
} = defineActuatorPipelineBase({
  manifestPath: SYSTEM_MANIFEST_PATH,
  retryDefaults: DEFAULT_SYSTEM_RETRY,
  retryFallbackCategories: ['network', 'rate_limit', 'timeout', 'resource_unavailable'],
  unsafeGates: { assertUnsafeJsAllowed: { env: 'KYBERION_ALLOW_UNSAFE_JS', label: 'JS' } },
});

export async function delegateToFilePipeline(
  step: PipelineStep,
  ctx: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const delegatedCtx = { ...ctx };
  delete delegatedCtx.context_path;
  const result = await handleFileAction({
    action: 'pipeline',
    steps: [step],
    context: delegatedCtx,
  } as unknown as Parameters<typeof handleFileAction>[0]);
  return result.context || ctx;
}

export function buildUnknownSystemOpMessage(op: string): string {
  return buildUnknownActuatorOpError('system', op).message;
}

export function warnDeprecatedSystemOpAlias(alias: string, canonical: string) {
  const warningKey = `${alias}->${canonical}`;
  if (warnedSystemOpAliases.has(warningKey)) return;
  warnedSystemOpAliases.add(warningKey);
  logger.warn(`[system-actuator] alias "${alias}" is deprecated; use "${canonical}" instead.`);
}

export function assertSystemOpInput(op: string, params: Record<string, unknown>) {
  const validation = validateOpInput('system', op, params);
  if (!validation.valid) {
    throw new Error(
      `[INVALID_OP_INPUT] system:${op} ${'errors' in validation ? validation.errors.join('; ') : ''}`
    );
  }
}

export function promoteDelegatedCapture(
  resultCtx: Record<string, unknown>,
  params: Record<string, unknown>,
  fallbackKey: string
): Record<string, unknown> {
  const exportAs = typeof params.export_as === 'string' ? params.export_as : undefined;
  if (!exportAs || resultCtx?.[exportAs] !== undefined) return resultCtx;
  if (resultCtx?.[fallbackKey] === undefined) return resultCtx;
  return { ...resultCtx, [exportAs]: resultCtx[fallbackKey] };
}

export function normalizeDisplayName(value: unknown): string | undefined {
  return systemDisplayHelpers.normalizeDisplayName(value);
}

export function normalizeApplicationName(value: unknown): string | undefined {
  return systemDisplayHelpers.normalizeApplicationName(value);
}

export function normalizeDisplayIndex(value: unknown): number | undefined {
  return systemDisplayHelpers.normalizeDisplayIndex(value);
}

export function selectDisplayFromInventory(
  inventory: ScreenDisplayInventory,
  requestedIndex?: number,
  requestedName?: string
): {
  display: ScreenDisplayRecord;
  selection_source: 'explicit_index' | 'display_name' | 'primary' | 'fallback';
} {
  return systemDisplayHelpers.selectDisplayFromInventory(inventory, requestedIndex, requestedName);
}

export async function resolveScreenDisplaySelection(
  params: Record<string, any>,
  resolve: (value: unknown) => unknown
): Promise<ResolvedScreenDisplaySelection> {
  return systemDisplayHelpers.resolveScreenDisplaySelection(params, resolve);
}

export const SYSTEM_ACTUATOR_CAPTURE_ALIAS_OPS = new Set<string>([
  'screenshot',
  'clipboard_read',
  'get_focused_input',
  'get_screen_size',
  'macos_automation_probe',
  'window_list',
  'chrome_tab_list',
  'read_file',
  'read_json',
  'probe',
  'probe_active_profile',
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

export function loadFocusTargetStore(): import('./system-focus-helpers.js').FocusTargetStore {
  return systemFocusHelpers.loadFocusTargetStore();
}

export function saveFocusTargetStore(store: import('./system-focus-helpers.js').FocusTargetStore) {
  systemFocusHelpers.saveFocusTargetStore(store);
}

export function rememberFocusedTarget(
  explicitId: string | undefined,
  focusedInput: FocusedInputState
) {
  return systemFocusHelpers.rememberFocusedTarget(explicitId, focusedInput);
}

export function loadRememberedFocusTarget(targetId?: string) {
  return systemFocusHelpers.loadRememberedFocusTarget(targetId);
}

export function detectFocusedInputWithGuard(
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

export function assertFocusedTargetMatches(
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

export function getFocusedTargetMismatches(
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

export function windowTitleMatches(
  expected: string,
  actual: string,
  matchPolicy: 'strict' | 'prefix' | 'contains'
) {
  return systemFocusHelpers.windowTitleMatches(expected, actual, matchPolicy);
}

export async function opControl(
  op: string,
  params: Record<string, unknown>,
  ctx: Record<string, unknown>,
  runSteps: (
    steps: AdfStep[],
    seedCtx?: Record<string, unknown>
  ) => Promise<AdfRunResult<Record<string, unknown>>>,
  _resolve: (value: unknown) => unknown
) {
  const runNested = async (steps: AdfStep[], seedCtx: Record<string, unknown> | undefined) => {
    const res = await runSteps(steps, seedCtx);
    if (res.status === 'failed') {
      const failedEntry = res.results.find((entry) => entry.status === 'failed');
      throw new Error(String(failedEntry?.error ?? 'nested pipeline failed'));
    }
    return res.context as Record<string, unknown>;
  };

  switch (op) {
    case 'if':
      if (evaluateCondition(params.condition, ctx)) {
        return await runNested(params.then as AdfStep[], ctx);
      } else if (params.else) {
        return await runNested(params.else as AdfStep[], ctx);
      }
      return ctx;

    case 'while': {
      let iterations = 0;
      const maxIter = params.max_iterations || undefined;
      while (
        evaluateCondition(params.condition, ctx) &&
        withinLoopBounds(iterations as number, maxIter as number)
      ) {
        logger.info(`    [LOOP] Iteration ${++iterations}...`);
        ctx = await runNested(params.pipeline as AdfStep[], ctx);
      }
      if (!withinLoopBounds(iterations as number, maxIter as number))
        logger.warn(
          `[SAFETY_GUARD] Loop reached max_iterations (${maxIter ?? DEFAULT_MAX_LOOP_ITERATIONS})`
        );
      return ctx;
    }

    default:
      throw new Error(buildUnknownSystemOpMessage(op));
  }
}

export function resolveCanonicalScreenRecordingPath(params: Record<string, unknown>): string {
  const requested = typeof params.output === 'string' ? params.output.trim() : '';
  const candidate = requested
    ? pathResolver.rootResolve(requested)
    : pathResolver.shared(`runtime/computer/screen-recording-${Date.now()}.mp4`);
  const absolute = path.resolve(candidate);
  const relative = path.relative(pathResolver.rootDir(), absolute);
  if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('record_screen output must remain within the Kyberion root');
  }
  return assertSafeRepositoryPath(absolute, { allowMissingLeaf: true });
}

export function resolveCanonicalScreenCapturePath(
  params: Record<string, unknown>,
  resolve: (value: unknown) => unknown
): string {
  const requested =
    typeof params.path === 'string' && params.path.trim()
      ? pathResolver.rootResolve(String(resolve(params.path)))
      : pathResolver.shared(
          `runtime/computer/screenshots/screenshot-${Date.now()}-${randomUUID()}.png`
        );
  const absolute = path.resolve(requested);
  const allowedRoots = [
    path.resolve(pathResolver.shared('runtime/computer/screenshots')),
    path.resolve(pathResolver.shared('tmp')),
  ];
  if (
    !allowedRoots.some((root) => absolute === root || absolute.startsWith(`${root}${path.sep}`))
  ) {
    throw new Error(
      'screenshot output must remain within the governed screenshot or shared tmp store'
    );
  }
  return assertSafeRepositoryPath(absolute, { allowMissingLeaf: true });
}
