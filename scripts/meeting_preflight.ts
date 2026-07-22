#!/usr/bin/env node
import * as path from 'node:path';
import {
  installCoreEnvironmentProbes,
  listToolRuntimeInventory,
  loadEnvironmentManifest,
  pathResolver,
  probeManifest,
  safeExecResult,
  safeExistsSync,
  safeReaddir,
  createCoreAudioDeviceInventoryBridge,
  resolveAudioDevice,
  type CoreAudioDeviceInventoryBridge,
} from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { collectDoctorReport } from './run_doctor.js';
import { checkSpeakConsent } from '../libs/actuators/meeting-actuator/src/meeting-actuator-helpers.js';

export type MeetingPreflightStatus = 'pass' | 'fail' | 'warn' | 'operator_action_required';

export interface MeetingPreflightItem {
  id: string;
  status: MeetingPreflightStatus;
  detail: string;
  fix: string;
  automatic_fix_available: boolean;
  reason_code?: string;
  data?: Record<string, unknown>;
}

export interface MeetingPreflightReport {
  items: MeetingPreflightItem[];
  ready: boolean;
}

function formatCommand(command?: string, args?: readonly string[]): string {
  const resolved = [command, ...(args ?? [])].filter((part): part is string => Boolean(part));
  return resolved.join(' ').trim();
}

function item(
  id: string,
  status: MeetingPreflightStatus,
  detail: string,
  fix: string,
  options: {
    automaticFixAvailable?: boolean;
    reasonCode?: string;
    data?: Record<string, unknown>;
  } = {}
): MeetingPreflightItem {
  return {
    id,
    status,
    detail,
    fix,
    automatic_fix_available: options.automaticFixAvailable ?? false,
    ...(options.reasonCode ? { reason_code: options.reasonCode } : {}),
    ...(options.data ? { data: options.data } : {}),
  };
}

function formatRates(rates?: readonly number[]): string {
  return rates && rates.length > 0
    ? rates.map((rate) => `${rate}Hz`).join(', ')
    : 'unknown sample rates';
}

async function probeDoctorMeeting(missionId?: string): Promise<MeetingPreflightItem> {
  const report = await collectDoctorReport({ runtime: 'meeting', mission: missionId });
  const meetingSummary = report.summaries.find(
    (summary) => summary.manifestId === 'meeting-participation-runtime'
  );
  const mustMissing = meetingSummary?.counts.must ?? 0;
  if (mustMissing > 0) {
    return item(
      'doctor.meeting',
      'fail',
      `meeting runtime has ${mustMissing} must gap(s)`,
      'pnpm env:bootstrap --manifest meeting-participation-runtime --apply'
    );
  }
  return item('doctor.meeting', 'pass', 'meeting runtime ready', 'none');
}

async function probePlaywrightBrowser(): Promise<MeetingPreflightItem> {
  const manifest = loadEnvironmentManifest('kyberion-toolchain');
  const probeStatuses = await probeManifest(manifest);
  const playwright = probeStatuses.find((status) => status.capability_id === 'playwright-chromium');
  if (playwright?.satisfied) {
    return item('playwright.browser', 'pass', 'Playwright Chromium cache is present', 'none');
  }
  return item(
    'playwright.browser',
    'fail',
    playwright?.reason || 'Playwright Chromium cache is missing',
    'pnpm exec playwright install chromium',
    { automaticFixAvailable: false, reasonCode: 'BROWSER_RUNTIME_MISSING' }
  );
}

async function probeBlackHoleDevice(
  platform: NodeJS.Platform,
  inventoryBridge: CoreAudioDeviceInventoryBridge = createCoreAudioDeviceInventoryBridge()
): Promise<MeetingPreflightItem> {
  if (platform !== 'darwin') {
    return item(
      'blackhole.device',
      'warn',
      `skipped on ${platform}; BlackHole is macOS-only`,
      'none',
      { reasonCode: 'BLACKHOLE_NOT_APPLICABLE' }
    );
  }
  const result = safeExecResult('system_profiler', ['SPAudioDataType'], {
    timeoutMs: 20_000,
    maxOutputMB: 2,
  });
  const output = `${result.stdout}\n${result.stderr}`.trim();
  if (result.status === 0 && /BlackHole/i.test(output)) {
    const inventory = await inventoryBridge.probe();
    const blackHoleDevices = inventory.devices.filter(
      (device) => device.display_name === 'BlackHole 2ch'
    );
    const input = resolveAudioDevice(blackHoleDevices, {
      expected_label: 'BlackHole 2ch',
      direction: 'input',
    });
    const outputDevice = resolveAudioDevice(blackHoleDevices, {
      expected_label: 'BlackHole 2ch',
      direction: 'output',
    });
    if (!input.descriptor || !outputDevice.descriptor) {
      const reason = input.reason || outputDevice.reason || 'BlackHole route is incomplete';
      return item(
        'blackhole.device',
        'operator_action_required',
        reason,
        'Open Audio MIDI Setup and select an exact BlackHole 2ch input/output device; do not change the system default output',
        {
          reasonCode: 'BLACKHOLE_ROUTE_INCOMPLETE',
          data: { devices: blackHoleDevices },
        }
      );
    }
    const inputDescriptor = input.descriptor;
    const outputDescriptor = outputDevice.descriptor;
    return item(
      'blackhole.device',
      'pass',
      `BlackHole 2ch ready; input/output UID ${inputDescriptor.uid}, ${inputDescriptor.channel_count ?? '?'} channel(s), rates ${formatRates(inputDescriptor.supported_sample_rates)}`,
      'pnpm voice:route:probe -- --json',
      {
        data: {
          input_device: inputDescriptor,
          output_device: outputDescriptor,
          uid_resolution: 'coreaudio_uid',
        },
      }
    );
  }
  const reason =
    result.status === 0
      ? 'system_profiler did not list BlackHole'
      : `system_profiler exited with code ${result.status}`;
  return item('blackhole.device', 'fail', reason, 'brew install blackhole-2ch', {
    reasonCode: 'BLACKHOLE_DRIVER_REQUIRED',
  });
}

async function probeCoreAudioOutputBridge(
  platform: NodeJS.Platform
): Promise<MeetingPreflightItem> {
  if (platform !== 'darwin') {
    return item(
      'coreaudio.output.bridge',
      'warn',
      `skipped on ${platform}; CoreAudio is macOS-only`,
      'none',
      {
        reasonCode: 'COREAUDIO_NOT_APPLICABLE',
      }
    );
  }
  const script = pathResolver.rootResolve('libs/core/coreaudio-output-bridge.swift');
  const inventoryScript = pathResolver.rootResolve('libs/core/coreaudio-device-inventory.swift');
  if (safeExistsSync(script) && safeExistsSync(inventoryScript)) {
    const inventory = await createCoreAudioDeviceInventoryBridge().probe();
    if (inventory.available) {
      const virtualDevices = inventory.devices.filter((device) => device.is_virtual);
      return item(
        'coreaudio.output.bridge',
        'pass',
        `CoreAudio bridge ready; ${virtualDevices.length} virtual device(s) discovered with stable UID metadata`,
        'none'
      );
    }
    return item(
      'coreaudio.output.bridge',
      'warn',
      inventory.reason || 'CoreAudio inventory returned no devices',
      'Open Audio MIDI Setup and confirm the target device; do not change the system default output',
      { reasonCode: 'COREAUDIO_DEVICE_INVENTORY_EMPTY' }
    );
  }
  return item(
    'coreaudio.output.bridge',
    'fail',
    'CoreAudio output helper is missing from the repository',
    'Rebuild Kyberion packages and restore libs/core/coreaudio-output-bridge.swift',
    { reasonCode: 'COREAUDIO_BRIDGE_MISSING' }
  );
}

function probeAudioPermission(platform: NodeJS.Platform): MeetingPreflightItem {
  if (platform !== 'darwin') {
    return item(
      'audio.permission',
      'warn',
      `OS audio permission probe is not applicable on ${platform}`,
      'none',
      {
        reasonCode: 'AUDIO_PERMISSION_NOT_APPLICABLE',
      }
    );
  }
  if (process.env.KYBERION_AUDIO_PERMISSION_CONFIRMED === '1') {
    return item(
      'audio.permission',
      'pass',
      'operator confirmed macOS microphone/audio input permission',
      'none'
    );
  }
  return item(
    'audio.permission',
    'operator_action_required',
    'macOS permission state is not auto-requested; operator confirmation is required before a live capture',
    'System Settings > Privacy & Security > Microphone; then set KYBERION_AUDIO_PERMISSION_CONFIRMED=1 for this session',
    { reasonCode: 'MICROPHONE_PERMISSION_REQUIRED' }
  );
}

function probeMlxAudioRuntime(platform: NodeJS.Platform): MeetingPreflightItem {
  const runtimeRoot = pathResolver.shared('runtime/tool-runtimes/mlx-audio');
  const pythonBin = path.join(runtimeRoot, 'bin', 'python');
  const python3Bin = path.join(runtimeRoot, 'bin', 'python3');
  if (safeExistsSync(pythonBin) || safeExistsSync(python3Bin)) {
    return item(
      'mlx.audio.runtime',
      'pass',
      `mlx-audio runtime is present at ${path.relative(pathResolver.rootDir(), safeExistsSync(pythonBin) ? pythonBin : python3Bin)}`,
      'none'
    );
  }

  const inventory = listToolRuntimeInventory('trial', platform);
  const mlxAudio = inventory.items.find((entry) => entry.tool.tool_id === 'mlx_audio');
  const fix =
    formatCommand(mlxAudio?.install_backend?.command, mlxAudio?.install_backend?.args) ||
    'pnpm voice:setup --apply';
  return item(
    'mlx.audio.runtime',
    'fail',
    `missing ${path.relative(pathResolver.rootDir(), pythonBin)}`,
    fix,
    { reasonCode: 'TTS_RUNTIME_MISSING' }
  );
}

function probeVoiceProfileStore(): MeetingPreflightItem {
  const storeDir = pathResolver.shared('runtime/voice-profiles');
  if (!safeExistsSync(storeDir)) {
    return item(
      'voice.profile',
      'fail',
      `voice profile store missing at ${path.relative(pathResolver.rootDir(), storeDir)}`,
      'Run Task 2: pnpm pipeline --input pipelines/voice-onboarding.json'
    );
  }

  const profileDirs = safeReaddir(storeDir).filter((entry) =>
    safeExistsSync(path.join(storeDir, entry, 'metadata.json'))
  );
  if (profileDirs.length > 0) {
    return item(
      'voice.profile',
      'pass',
      `voice profile store contains ${profileDirs.length} profile(s)`,
      'none'
    );
  }

  return item(
    'voice.profile',
    'fail',
    `voice profile store has no metadata.json profiles under ${path.relative(pathResolver.rootDir(), storeDir)}`,
    'Run Task 2: pnpm pipeline --input pipelines/voice-onboarding.json',
    { reasonCode: 'VOICE_PROFILE_MISSING' }
  );
}

function probeVoiceConsent(): MeetingPreflightItem {
  const consent = checkSpeakConsent();
  if (consent.allowed) {
    return item('voice.consent', 'pass', 'voice consent is granted for the active mission', 'none');
  }
  return item(
    'voice.consent',
    'fail',
    consent.reason || 'voice consent is not granted',
    'pnpm meeting:consent grant --mission <MISSION_ID> --operator <handle>',
    { reasonCode: 'VOICE_CONSENT_REQUIRED' }
  );
}

async function probeReasoningBackend(): Promise<MeetingPreflightItem> {
  const manifest = loadEnvironmentManifest('reasoning-backend');
  const probeStatuses = await probeManifest(manifest);
  const backend = probeStatuses.find(
    (status) => status.capability_id === 'reasoning-backend.any-real'
  );
  if (backend?.satisfied) {
    return item('reasoning.backend', 'pass', 'a real reasoning backend is available', 'none');
  }
  return item(
    'reasoning.backend',
    'fail',
    backend?.reason || 'no real reasoning backend reachable',
    'pnpm reasoning:setup',
    { reasonCode: 'REAL_REASONING_BACKEND_REQUIRED' }
  );
}

export async function runMeetingPreflight(
  options: {
    missionId?: string;
    platform?: NodeJS.Platform;
    inventory_bridge?: CoreAudioDeviceInventoryBridge;
  } = {}
): Promise<MeetingPreflightReport> {
  installCoreEnvironmentProbes();
  const missionId = options.missionId?.trim() || process.env.MISSION_ID?.trim() || undefined;
  if (missionId) process.env.MISSION_ID = missionId;
  const platform = options.platform || process.platform;

  const items = [
    await probeDoctorMeeting(missionId),
    await probePlaywrightBrowser(),
    await probeBlackHoleDevice(platform, options.inventory_bridge),
    await probeCoreAudioOutputBridge(platform),
    probeAudioPermission(platform),
    probeMlxAudioRuntime(platform),
    probeVoiceProfileStore(),
    probeVoiceConsent(),
    await probeReasoningBackend(),
  ];

  return {
    items,
    ready: items.every(
      (entry) => entry.status !== 'fail' && entry.status !== 'operator_action_required'
    ),
  };
}

function printMeetingPreflightReport(report: MeetingPreflightReport): void {
  for (const entry of report.items) {
    console.log(`[meeting-preflight] ${entry.id}: ${entry.status}`);
    console.log(`  detail: ${entry.detail}`);
    console.log(`  fix: ${entry.fix}`);
  }
  console.log('');
}

export async function main(): Promise<void> {
  const argv = await createStandardYargs()
    .option('mission', { type: 'string' })
    .option('json', { type: 'boolean', default: false })
    .parseSync();

  const report = await runMeetingPreflight({
    missionId: argv.mission ? String(argv.mission) : undefined,
  });

  if (argv.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printMeetingPreflightReport(report);
  }

  process.exit(report.ready ? 0 : 1);
}

const isDirect = process.argv[1] && /meeting_preflight\.(ts|js)$/.test(process.argv[1]);
if (isDirect) {
  main().catch((err) => {
    console.error(err?.message ?? String(err));
    process.exit(1);
  });
}
