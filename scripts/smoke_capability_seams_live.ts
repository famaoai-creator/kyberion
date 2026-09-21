/**
 * Live seam verification — exercises each newly seamed capability at runtime.
 *
 *   pnpm exec tsx scripts/smoke_capability_seams_live.ts
 */

import { pathResolver } from '@agent/core/path-resolver';
import { safeMkdir, safeWriteFile } from '@agent/core/secure-io';
import { nowIso } from '@agent/core/foundation';

import '@agent/core/audio-bus-resolver';
import { listAudioBusBridges, resolveAudioBus } from '@agent/core/audio-bus-bridge';

import '@agent/core/agent-lifecycle';
import {
  createAgentExecAdapter,
  hasAgentExecAdapter,
  listAgentExecAdapterBridges,
} from '@agent/core/agent-exec-adapter-bridge';

import '@agent/core/agent-pane-runtime-herdr';
import {
  listAgentPaneRuntimeBridges,
  resolveAgentPaneRuntimeBridge,
  resolveAgentRuntimeLaunchMode,
} from '@agent/core/agent-pane-runtime-bridge';

import { listOcrProviders, ocrImage } from '@agent/core/ocr-bridge';
import { generateImage, listImageGenerationProviders } from '@agent/core/image-generation-bridge';
import {
  createVirtualCameraBridge,
  listVirtualCameraCaptureBackends,
} from '@agent/core/virtual-camera-bridge';
import {
  listCalendarProviders,
  resolveCalendarProvider,
} from '@agent/core/calendar-provider-bridge';
import {
  listBrowserAutomationRuntimeBridges,
  resolveBrowserAutomationRuntime,
} from '@agent/core/browser-automation-runtime-bridge';

type CheckResult = {
  seam: string;
  ok: boolean;
  detail: Record<string, unknown>;
  error?: string;
};

const results: CheckResult[] = [];

function record(seam: string, ok: boolean, detail: Record<string, unknown>, error?: string): void {
  results.push({ seam, ok, detail, ...(error ? { error } : {}) });
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`[${mark}] ${seam}: ${error || JSON.stringify(detail)}`);
}

async function checkAudioBus(): Promise<void> {
  try {
    const ids = listAudioBusBridges().map((b) => b.bridge_id);
    const stub = resolveAudioBus('stub');
    const probe = await stub.probe();
    record(
      'audio-bus-bridge',
      ids.includes('stub') &&
        ids.includes('blackhole') &&
        ids.includes('pulseaudio') &&
        probe.bus_id === 'stub',
      { registered: ids, stub_probe: probe }
    );
  } catch (error) {
    record('audio-bus-bridge', false, {}, error instanceof Error ? error.message : String(error));
  }
}

async function checkExecAdapter(): Promise<void> {
  try {
    const ids = listAgentExecAdapterBridges()
      .map((b) => b.bridge_id)
      .sort();
    const hasClaude = await hasAgentExecAdapter('claude');
    const hasCodex = await hasAgentExecAdapter('codex');
    const hasAgy = await hasAgentExecAdapter('agy');
    const adapter = await createAgentExecAdapter({
      provider: 'claude',
      cwd: pathResolver.rootDir(),
      systemPrompt: 'seam-smoke',
    });
    const shape = typeof adapter.boot === 'function' && typeof adapter.ask === 'function';
    record(
      'agent-exec-adapter-bridge',
      hasClaude && hasCodex && hasAgy && shape && ids.includes('claude'),
      { registered: ids, hasClaude, hasCodex, hasAgy, adapter_methods: shape }
    );
  } catch (error) {
    record(
      'agent-exec-adapter-bridge',
      false,
      {},
      error instanceof Error ? error.message : String(error)
    );
  }
}

async function checkPaneRuntime(): Promise<void> {
  try {
    const mode = resolveAgentRuntimeLaunchMode({
      env: { KYBERION_AGENT_RUNTIME_BACKEND: 'pane' },
    });
    const ids = listAgentPaneRuntimeBridges().map((b) => b.bridge_id);
    const bridge = await resolveAgentPaneRuntimeBridge('herdr');
    const probe = await bridge.probe();
    record(
      'agent-pane-runtime-bridge',
      mode === 'pane' && ids.includes('herdr') && typeof probe.available === 'boolean',
      { mode, registered: ids, probe }
    );
  } catch (error) {
    record(
      'agent-pane-runtime-bridge',
      false,
      {},
      error instanceof Error ? error.message : String(error)
    );
  }
}

async function checkOcr(): Promise<void> {
  try {
    await ocrImage({ path: 'active/shared/tmp/.seam-ocr-missing.png' }).catch(() => undefined);
    const ids = listOcrProviders().map((p) => p.id);
    record('ocr-provider', ids.length >= 3, { registered: ids });
  } catch (error) {
    record('ocr-provider', false, {}, error instanceof Error ? error.message : String(error));
  }
}

async function checkImageGen(): Promise<void> {
  try {
    await generateImage({ prompt: 'seam-smoke', mode: 'local_only' }).catch(() => undefined);
    const ids = listImageGenerationProviders().map((p) => p.id);
    record('image-generation-provider', ids.length >= 5, { registered: ids });
  } catch (error) {
    record(
      'image-generation-provider',
      false,
      {},
      error instanceof Error ? error.message : String(error)
    );
  }
}

async function checkVirtualCamera(): Promise<void> {
  try {
    const bridge = createVirtualCameraBridge({ preferred_backend: 'stub' });
    const probe = await bridge.probe();
    const outDir = pathResolver.sharedTmp('seam-smoke-camera');
    safeMkdir(outDir, { recursive: true });
    const savePath = `${outDir}/stub-capture.png`;
    const capture = await bridge.capturePhoto({ save_path: savePath });
    const backends = listVirtualCameraCaptureBackends().map((b) => b.backend_id);
    record(
      'virtual-camera-capture',
      probe.backend === 'stub' &&
        capture.backend === 'stub' &&
        backends.includes('stub') &&
        backends.includes('ffmpeg'),
      { probe, capture_path: capture.save_path, backends }
    );
  } catch (error) {
    record(
      'virtual-camera-capture',
      false,
      {},
      error instanceof Error ? error.message : String(error)
    );
  }
}

async function checkCalendar(): Promise<void> {
  try {
    const ids = listCalendarProviders()
      .map((p) => p.provider_id)
      .sort();
    const google = resolveCalendarProvider('google-workspace');
    const m365 = resolveCalendarProvider('m365');
    record(
      'calendar-provider',
      ids.includes('google-workspace') &&
        ids.includes('m365') &&
        google.resolveCalendarPath('primary') === 'primary' &&
        m365.resolveCalendarPath('primary') === 'me',
      {
        registered: ids,
        google_path: google.resolveCalendarPath('primary'),
        m365_path: m365.resolveCalendarPath('primary'),
      }
    );
  } catch (error) {
    record('calendar-provider', false, {}, error instanceof Error ? error.message : String(error));
  }
}

async function checkBrowser(): Promise<void> {
  try {
    await import('../libs/actuators/browser-actuator/src/browser-automation-runtime-playwright.js');
    const ids = listBrowserAutomationRuntimeBridges().map((b) => b.bridge_id);
    const runtime = resolveBrowserAutomationRuntime();
    record(
      'browser-automation-runtime',
      ids.includes('playwright-chromium') &&
        runtime.bridge_id === 'playwright-chromium' &&
        typeof runtime.connectOverCDP === 'function',
      { registered: ids, selected: runtime.bridge_id }
    );
  } catch (error) {
    record(
      'browser-automation-runtime',
      false,
      {},
      error instanceof Error ? error.message : String(error)
    );
  }
}

async function main(): Promise<void> {
  await checkAudioBus();
  await checkExecAdapter();
  await checkPaneRuntime();
  await checkOcr();
  await checkImageGen();
  await checkVirtualCamera();
  await checkCalendar();
  await checkBrowser();

  const failed = results.filter((r) => !r.ok);
  const report = {
    checked_at: nowIso(),
    passed: results.filter((r) => r.ok).length,
    failed: failed.length,
    results,
  };
  const outDir = pathResolver.sharedTmp('seam-smoke');
  safeMkdir(outDir, { recursive: true });
  const outPath = `${outDir}/capability-seams-live.json`;
  safeWriteFile(outPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nReport: ${outPath}`);
  console.log(`Summary: ${report.passed} passed, ${report.failed} failed`);
  if (failed.length > 0) process.exitCode = 1;
}

void main();
