/** Shared guards and control/display helpers for the system pipeline actuator. */

import { logger } from '@agent/core/core';
import {
  assertSafeRepositoryPath,
  safeReadFile,
  safeMkdir,
  safeExec,
  safeExecResult,
  safeExistsSync,
  safeLstat,
  safeStat,
} from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';
import { resolveVars, evaluateCondition } from '@agent/core/src/logic-utils';
import { createGovernedRetryOptionsBuilder } from '@agent/core/recovery-policy';
import { resolveActiveProfileRoot } from '@agent/core/profile-root';
import { retry } from '@agent/core/async-utils';
import { createVirtualMediaDeviceControlBridge } from '@agent/core/virtual-media-device-control-bridge';
import { createVirtualDeviceInventoryBridge } from '@agent/core/virtual-device-inventory-bridge';
import { createVirtualAudioOutputPlaybackBridge } from '@agent/core/virtual-audio-output-playback-bridge';
import { createVirtualAudioInputRecordingBridge } from '@agent/core/virtual-audio-input-recording-bridge';
import { createVirtualInputDeviceInventoryBridge } from '@agent/core/virtual-input-device-inventory-bridge';
import { createVirtualCameraBridge } from '@agent/core/virtual-camera-bridge';
import { createVirtualCameraInjectionBridge } from '@agent/core/virtual-camera-injection-bridge';
import { createScreenCaptureBridge } from '@agent/core/screen-capture-bridge';
import { createScreenRecordingBridge } from '@agent/core/screen-recording-bridge';
import {
  redactScreenVideoFrame,
  redactScreenCaptureFile,
} from '@agent/core/screen-frame-redaction';
import { createScreenDisplayInventoryBridge } from '@agent/core/screen-display-inventory-bridge';
import { listToolRuntimeInventory } from '@agent/core/tool-runtime-registry';
import { listServiceRuntimeInventory } from '@agent/core/service-runtime-registry';
import { probeSileroVad } from '@agent/core/silero-vad-bridge';
import { buildUnknownActuatorOpError } from '@agent/core/actuator-op-registry';
import type {
  ScreenDisplayInventory,
  ScreenDisplayRecord,
} from '@agent/core/screen-display-inventory-bridge';
import { StubVideoFrameBus } from '@agent/core/video-frame-bus';
import { writeVideoFrameBusToMp4, pipeMp4ToVideoFrameBus } from '@agent/core/video-frame-archive';
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
import { getRegisteredEnv, readJson } from '@agent/core/foundation';
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
} from '@agent/core/os-automation';
import type { FocusedInputState } from '@agent/core/os-automation';
import { validateOpInput } from '@agent/core/op-input-contracts';
import {
  systemDisplayHelpers,
  type ResolvedScreenDisplaySelection,
} from './system-display-helpers.js';
import { systemFocusHelpers } from './system-focus-helpers.js';
import * as visionJudge from '@agent/shared-vision';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

function resolveSystemPath(ref: string, allowMissingLeaf = true): string {
  return assertSafeRepositoryPath(pathResolver.rootResolve(ref), { allowMissingLeaf });
}

export const ALLOW_UNSAFE_SHELL =
  getRegisteredEnv<boolean>('KYBERION_ALLOW_UNSAFE_SHELL', { defaultValue: false }) === true;
export const ALLOW_UNSAFE_JS =
  getRegisteredEnv<boolean>('KYBERION_ALLOW_UNSAFE_JS', { defaultValue: false }) === true;
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

export async function writeRedactedScreenFrames(
  bridge: ReturnType<typeof createScreenCaptureBridge>,
  bus: StubVideoFrameBus,
  input: Record<string, unknown>
): Promise<void> {
  const redactingBus = {
    writeFrames: async (stream: AsyncIterable<any>) =>
      bus.writeFrames(
        (async function* () {
          for await (const frame of stream) {
            const redacted = await redactScreenVideoFrame(frame);
            if (!redacted || redacted.payload.byteLength === 0) {
              throw new Error('screen frame withheld: redaction_failed');
            }
            yield redacted;
          }
        })()
      ),
  };
  await bridge.pipeTo(redactingBus as any, input);
}
export async function opCapture(op: string, params: any, ctx: any, resolve: (value: any) => any) {
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
        activateWindowByTitle(application || 'Google Chrome', windowTitle, windowMatchPolicy);
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
      } as any);
      await redactScreenCaptureFile(captureResult.save_path || rawScreenshotPath, screenshotPath);
      return {
        ...ctx,
        [params.export_as || 'screenshot_path']: screenshotPath,
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
      const bridge = createScreenRecordingBridge({ frame_redactor: redactScreenVideoFrame });
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
        [params.export_as || 'screen_recording']: {
          ...result,
          status: 'succeeded',
          bridge_id: bridge.bridge_id,
          selected_display_index: displaySelection.display_index,
          selected_display_name: displaySelection.display_name,
          display_selection_source: displaySelection.selection_source,
        },
      };
    }
    case 'macos_automation_probe':
      return {
        ...ctx,
        [params.export_as || 'macos_automation']: {
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
      await writeRedactedScreenFrames(bridge, bus, {
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
      await writeRedactedScreenFrames(bridge, captureBus, {
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
    // LE-03: registry reconcile sweeps as in-process typed ops (formerly
    // `system:shell` wrappers around dist/scripts/reconcile_*.js). Structured
    // results land directly in ctx — no stdout parsing, no silent `|| echo` fallback.
    case 'reconcile_config_fallbacks':
      return { ...ctx, [params.export_as || 'reconcile_result']: reconcileConfigFallbacks() };
    case 'reconcile_unclassified_errors':
      return { ...ctx, [params.export_as || 'reconcile_result']: reconcileUnclassifiedErrors() };
    case 'reconcile_unhandled_intents':
      return { ...ctx, [params.export_as || 'reconcile_result']: reconcileUnhandledIntents() };
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
        [params.export_as || 'cost_report']: buildCostReportFromHistory({
          since,
          until: params.until ? String(resolve(params.until)) : undefined,
        }),
      };
    }
    case 'audit_verify':
      return {
        ...ctx,
        [params.export_as || 'audit_report']: collectAuditVerifyReport({
          since: params.since ? String(resolve(params.since)) : undefined,
          ledgers: Array.isArray(params.ledgers) ? params.ledgers.map(String) : undefined,
        }),
      };
    case 'summarize_memory_promotion_queue':
      return {
        ...ctx,
        [params.export_as || 'memory_queue_summary']: runMemoryPromotionQueueSummary({
          status: params.status ? String(resolve(params.status)) : undefined,
          output_path: params.output_path ? String(resolve(params.output_path)) : undefined,
        }),
      };
    case 'summarize_task_model_routing':
      return {
        ...ctx,
        [params.export_as || 'task_model_routing_summary']: runTaskModelRoutingSummary({
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
            cwd: params.cwd ? resolveSystemPath(String(resolve(params.cwd)), false) : rootDir,
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
        [params.export_as || 'last_capture_data']: readJson<unknown>(
          resolveSystemPath(String(resolve(params.path)))
        ),
      };
    case 'probe': {
      if (params.capability === 'silero_vad') {
        const status = probeSileroVad();
        return {
          ...ctx,
          [params.export_as || 'last_probe']: {
            capability: 'silero_vad',
            available: status.available,
            ...(status.reason ? { reason: status.reason } : {}),
          },
        };
      }
      const targetPath = resolveSystemPath(String(resolve(params.path)));
      let exists = false;
      let kind = 'unknown';
      try {
        exists = await retry(
          async () => safeExistsSync(targetPath),
          buildRetryOptions(params.retry)
        );
        if (exists) {
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
        [params.export_as || 'last_probe']: {
          path: relativePath,
          exists,
          kind,
        },
      };
    }
    case 'glob_files':
      return {
        ...ctx,
        [params.export_as || 'file_list']: getAllFiles(
          resolveSystemPath(String(resolve(params.dir)))
        )
          .filter((f) => !params.ext || f.endsWith(params.ext))
          .map((f) => path.relative(pathResolver.rootDir(), f)),
      };
    case 'scan_directory': {
      const { safeReaddir, safeExistsSync: scanExists } = await import('@agent/core/secure-io');
      const scanRoot = resolveSystemPath(String(resolve(params.path || '.')));
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
      const { ledger } = await import('@agent/core/ledger');
      return { ...ctx, [params.export_as || 'ledger_valid']: ledger.verifyIntegrity() };
    }
    case 'baseline_check': {
      const report = await runBaselineCheck();
      return { ...ctx, [params.export_as || 'baseline_check']: report };
    }
    case 'list_missions': {
      const missionRoot = resolveSystemPath('active/missions');
      const tiers = ['personal', 'confidential', 'public'];
      const requestedStatus =
        typeof params.status === 'string' && params.status.trim()
          ? params.status.trim()
          : undefined;
      const allMissions: any[] = [];
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
            let state: any = null;
            if (safeExistsSync(statePath)) {
              try {
                state = readJson<unknown>(statePath);
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
      const { listProjectRecords } = await import('@agent/core/project-registry');
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
          if (safeLstat(actuatorPath).isDirectory() && safeExistsSync(pkgPath)) {
            try {
              const pkg = readJson<{
                name?: unknown;
                description?: unknown;
                version?: unknown;
              }>(assertSafeRepositoryPath(pkgPath));
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
      return { ...ctx, [params.export_as || 'artifact_collection']: results };
    }
    case 'sample_traces': {
      const missionRoot = resolveSystemPath('active/missions');
      const count = Number(params.count || 5);
      const allTraces: any[] = [];
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
        trace: readJson<unknown>(assertSafeRepositoryPath(s.path)),
      }));
      return { ...ctx, [params.export_as || 'sampled_traces']: results };
    }
    case 'list_running_apps': {
      const { platform } = await import('@agent/core/platform');
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
          ? resolveSystemPath(params.input_mp4_path.trim(), false)
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

export const warnedSystemOpAliases = new Set<string>();

export interface PipelineStep {
  type: 'capture' | 'transform' | 'apply' | 'control';
  op: string;
  params: any;
}

export function assertUnsafeShellAllowed() {
  if (!ALLOW_UNSAFE_SHELL) {
    throw new Error(
      '[SECURITY] Shell execution disabled. Set KYBERION_ALLOW_UNSAFE_SHELL=true to enable.'
    );
  }
}

export function assertUnsafeJsAllowed() {
  if (!ALLOW_UNSAFE_JS) {
    throw new Error(
      '[SECURITY] JS execution disabled. Set KYBERION_ALLOW_UNSAFE_JS=true to enable.'
    );
  }
}

export const buildRetryOptions = createGovernedRetryOptionsBuilder({
  manifestPath: SYSTEM_MANIFEST_PATH,
  defaults: DEFAULT_SYSTEM_RETRY,
  fallbackCategories: ['network', 'rate_limit', 'timeout', 'resource_unavailable'],
});

export async function delegateToFilePipeline(step: PipelineStep, ctx: any): Promise<any> {
  const delegatedCtx = { ...ctx };
  delete delegatedCtx.context_path;
  const result = await handleFileAction({
    action: 'pipeline',
    steps: [step],
    context: delegatedCtx,
  } as any);
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

export function assertSystemOpInput(op: string, params: any) {
  const validation = validateOpInput('system', op, params);
  if (!validation.valid) {
    throw new Error(
      `[INVALID_OP_INPUT] system:${op} ${'errors' in validation ? validation.errors.join('; ') : ''}`
    );
  }
}

export function promoteDelegatedCapture(resultCtx: any, params: any, fallbackKey: string): any {
  const exportAs = params.export_as;
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
  resolve: (value: any) => any
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
