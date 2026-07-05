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
} from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { collectDoctorReport } from './run_doctor.js';
import { checkSpeakConsent } from '../libs/actuators/meeting-actuator/src/meeting-actuator-helpers.js';

export type MeetingPreflightStatus = 'pass' | 'fail' | 'warn';

export interface MeetingPreflightItem {
  id: string;
  status: MeetingPreflightStatus;
  detail: string;
  fix: string;
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
  fix: string
): MeetingPreflightItem {
  return { id, status, detail, fix };
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
    'pnpm exec playwright install chromium'
  );
}

async function probeBlackHoleDevice(platform: NodeJS.Platform): Promise<MeetingPreflightItem> {
  if (platform !== 'darwin') {
    return item(
      'blackhole.device',
      'warn',
      `skipped on ${platform}; BlackHole is macOS-only`,
      'none'
    );
  }
  const result = safeExecResult('system_profiler', ['SPAudioDataType'], {
    timeoutMs: 20_000,
    maxOutputMB: 2,
  });
  const output = `${result.stdout}\n${result.stderr}`.trim();
  if (result.status === 0 && /BlackHole/i.test(output)) {
    return item('blackhole.device', 'pass', 'BlackHole 2ch is listed by system_profiler', 'none');
  }
  const reason =
    result.status === 0
      ? 'system_profiler did not list BlackHole'
      : `system_profiler exited with code ${result.status}`;
  return item('blackhole.device', 'fail', reason, 'brew install blackhole-2ch');
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
    fix
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
    'Run Task 2: pnpm pipeline --input pipelines/voice-onboarding.json'
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
    'pnpm meeting:consent grant --mission <MISSION_ID> --operator <handle>'
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
    'pnpm reasoning:setup'
  );
}

export async function runMeetingPreflight(
  options: {
    missionId?: string;
    platform?: NodeJS.Platform;
  } = {}
): Promise<MeetingPreflightReport> {
  installCoreEnvironmentProbes();
  const missionId = options.missionId?.trim() || process.env.MISSION_ID?.trim() || undefined;
  if (missionId) process.env.MISSION_ID = missionId;
  const platform = options.platform || process.platform;

  const items = [
    await probeDoctorMeeting(missionId),
    await probePlaywrightBrowser(),
    await probeBlackHoleDevice(platform),
    probeMlxAudioRuntime(platform),
    probeVoiceProfileStore(),
    probeVoiceConsent(),
    await probeReasoningBackend(),
  ];

  return {
    items,
    ready: items.every((entry) => entry.status !== 'fail'),
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
