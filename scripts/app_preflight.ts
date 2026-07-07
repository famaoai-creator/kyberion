#!/usr/bin/env node
/**
 * E2E-05 Task 1: mobile app-lifecycle preflight.
 * Answers "can this machine run the iOS/Android SDLC loop right now?" with
 * pass/fail/warn per item and a copy-pasteable fix for every failure.
 */
import { safeExecResult, secretGuard } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';

export type AppPreflightStatus = 'pass' | 'fail' | 'warn';

export interface AppPreflightItem {
  id: string;
  status: AppPreflightStatus;
  detail: string;
  fix: string;
}

export interface AppPreflightReport {
  platform: 'ios' | 'android' | 'all';
  items: AppPreflightItem[];
  ready: boolean;
}

function item(
  id: string,
  status: AppPreflightStatus,
  detail: string,
  fix: string
): AppPreflightItem {
  return { id, status, detail, fix };
}

function probeBinary(id: string, binary: string, fix: string): AppPreflightItem {
  const result = safeExecResult('which', [binary], { timeoutMs: 10_000 });
  if (result.status === 0 && String(result.stdout || '').trim()) {
    return item(id, 'pass', `${binary} found at ${String(result.stdout).trim()}`, 'none');
  }
  return item(id, 'fail', `${binary} not found on PATH`, fix);
}

function probeIosRuntimes(): AppPreflightItem {
  if (process.platform !== 'darwin') {
    return item(
      'ios.runtime',
      'warn',
      `skipped on ${process.platform}; iOS builds are macOS-only`,
      'none'
    );
  }
  const result = safeExecResult('xcrun', ['simctl', 'list', 'runtimes'], { timeoutMs: 30_000 });
  const output = String(result.stdout || '');
  if (result.status === 0 && /iOS [\d.]+/.test(output)) {
    const count = (output.match(/iOS [\d.]+/g) || []).length;
    return item('ios.runtime', 'pass', `${count} iOS simulator runtime(s) available`, 'none');
  }
  return item(
    'ios.runtime',
    'fail',
    result.status === 0 ? 'no iOS simulator runtime installed' : `simctl exited ${result.status}`,
    'Xcode > Settings > Platforms から iOS Simulator runtime を導入'
  );
}

function probeAndroidEnv(): AppPreflightItem {
  if (process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT) {
    return item(
      'android.env',
      'pass',
      `ANDROID_HOME=${process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT}`,
      'none'
    );
  }
  return item(
    'android.env',
    'fail',
    'ANDROID_HOME / ANDROID_SDK_ROOT is not set',
    'export ANDROID_HOME=$HOME/Library/Android/sdk (shell profile に追記)'
  );
}

function probeAndroidDevices(): AppPreflightItem {
  const devices = safeExecResult('adb', ['devices'], { timeoutMs: 20_000 });
  const attached = String(devices.stdout || '')
    .split('\n')
    .slice(1)
    .filter((line) => /\bdevice\b|\bemulator\b/.test(line)).length;
  if (devices.status === 0 && attached > 0) {
    return item('android.device', 'pass', `${attached} device(s)/emulator(s) attached`, 'none');
  }
  const avds = safeExecResult('emulator', ['-list-avds'], { timeoutMs: 20_000 });
  const avdCount = String(avds.stdout || '')
    .split('\n')
    .filter((line) => line.trim()).length;
  if (avds.status === 0 && avdCount > 0) {
    return item(
      'android.device',
      'warn',
      `no device attached, but ${avdCount} AVD(s) available (boot one to run device tests)`,
      'emulator -avd <name> で起動'
    );
  }
  return item(
    'android.device',
    'fail',
    'no attached device and no AVD defined',
    'Android Studio Device Manager で AVD を作成、または実機を接続'
  );
}

function probeSecret(id: string, secretName: string, fix: string): AppPreflightItem {
  try {
    const value = secretGuard.getSecret(secretName);
    if (value) return item(id, 'pass', `secret ${secretName} is present (value not shown)`, 'none');
  } catch {
    // fall through to fail
  }
  return item(id, 'fail', `secret ${secretName} is missing`, fix);
}

export function runAppPreflight(options: {
  platform?: 'ios' | 'android' | 'all';
  full?: boolean;
}): AppPreflightReport {
  const platform = options.platform || 'all';
  const items: AppPreflightItem[] = [];

  if (platform === 'ios' || platform === 'all') {
    items.push(
      probeBinary('ios.xcrun', 'xcrun', 'Xcode を導入し xcode-select を設定'),
      probeBinary('ios.xcodebuild', 'xcodebuild', 'Xcode を導入し xcode-select を設定'),
      probeIosRuntimes()
    );
  }
  if (platform === 'android' || platform === 'all') {
    items.push(
      probeBinary('android.adb', 'adb', 'Android platform-tools を導入し PATH に追加'),
      probeAndroidEnv(),
      probeAndroidDevices()
    );
  }
  if (options.full) {
    items.push(
      probeBinary(
        'distribution.fastlane',
        'fastlane',
        'gem install fastlane または brew install fastlane'
      )
    );
    if (platform === 'ios' || platform === 'all') {
      items.push(
        probeSecret(
          'distribution.ios.api_key',
          'APP_STORE_CONNECT_API_KEY',
          'vault に APP_STORE_CONNECT_API_KEY を登録 (値はログに出さない)'
        )
      );
    }
    if (platform === 'android' || platform === 'all') {
      items.push(
        probeSecret(
          'distribution.android.keystore',
          'ANDROID_KEYSTORE_PATH',
          'vault に ANDROID_KEYSTORE_PATH を登録 (keystore はコミットしない)'
        )
      );
    }
  }

  return {
    platform,
    items,
    // warn does not block: an unattached device only blocks device tests.
    ready: items.every((entry) => entry.status !== 'fail'),
  };
}

function printReport(report: AppPreflightReport): void {
  for (const entry of report.items) {
    console.log(`[app-preflight] ${entry.id}: ${entry.status}`);
    console.log(`  detail: ${entry.detail}`);
    if (entry.fix !== 'none') console.log(`  fix: ${entry.fix}`);
  }
  console.log('');
  console.log(`[app-preflight] ready: ${report.ready}`);
}

export async function main(): Promise<void> {
  const argv = await createStandardYargs()
    .option('platform', { type: 'string', default: 'all', choices: ['ios', 'android', 'all'] })
    .option('full', { type: 'boolean', default: false, description: 'include distribution checks' })
    .option('json', { type: 'boolean', default: false })
    .parseSync();

  const report = runAppPreflight({
    platform: argv.platform as 'ios' | 'android' | 'all',
    full: Boolean(argv.full),
  });

  if (argv.json) console.log(JSON.stringify(report, null, 2));
  else printReport(report);
  process.exit(report.ready ? 0 : 1);
}

const isDirect = process.argv[1] && /app_preflight\.(ts|js)$/.test(process.argv[1]);
if (isDirect) {
  main().catch((err) => {
    console.error(err?.message ?? String(err));
    process.exit(1);
  });
}
