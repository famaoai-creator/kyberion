import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  safeExecResult: vi.fn(),
  getSecret: vi.fn(),
}));

vi.mock('@agent/core', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as any),
    safeExecResult: mocks.safeExecResult,
    secretGuard: { getSecret: mocks.getSecret },
  };
});

import { runAppPreflight } from './app_preflight.js';

describe('app_preflight (E2E-05 Task 1)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    delete process.env.ANDROID_HOME;
    delete process.env.ANDROID_SDK_ROOT;
  });

  it('passes android checks when adb, env and a device are present', () => {
    process.env.ANDROID_HOME = '/opt/android-sdk';
    mocks.safeExecResult.mockImplementation((command: string, args: string[]) => {
      if (command === 'which') return { stdout: `/usr/bin/${args[0]}\n`, stderr: '', status: 0 };
      if (command === 'adb')
        return {
          stdout: 'List of devices attached\nemulator-5554\tdevice\n',
          stderr: '',
          status: 0,
        };
      return { stdout: '', stderr: '', status: 1 };
    });
    const report = runAppPreflight({ platform: 'android' });
    expect(report.ready).toBe(true);
    expect(report.items.map((entry) => entry.status)).toEqual(['pass', 'pass', 'pass']);
  });

  it('fails with actionable fixes when the android toolchain is missing', () => {
    mocks.safeExecResult.mockReturnValue({ stdout: '', stderr: '', status: 1 });
    const report = runAppPreflight({ platform: 'android' });
    expect(report.ready).toBe(false);
    const adb = report.items.find((entry) => entry.id === 'android.adb')!;
    expect(adb.status).toBe('fail');
    expect(adb.fix).toContain('platform-tools');
    const env = report.items.find((entry) => entry.id === 'android.env')!;
    expect(env.status).toBe('fail');
    expect(env.fix).toContain('ANDROID_HOME');
  });

  it('warns (not fails) when no device is attached but an AVD exists', () => {
    process.env.ANDROID_HOME = '/opt/android-sdk';
    mocks.safeExecResult.mockImplementation((command: string, args: string[]) => {
      if (command === 'which') return { stdout: `/usr/bin/${args[0]}\n`, stderr: '', status: 0 };
      if (command === 'adb') return { stdout: 'List of devices attached\n', stderr: '', status: 0 };
      if (command === 'emulator') return { stdout: 'Pixel_8_API_34\n', stderr: '', status: 0 };
      return { stdout: '', stderr: '', status: 1 };
    });
    const report = runAppPreflight({ platform: 'android' });
    expect(report.ready).toBe(true);
    expect(report.items.find((entry) => entry.id === 'android.device')?.status).toBe('warn');
  });

  it('--full checks fastlane and secrets without printing values', () => {
    process.env.ANDROID_HOME = '/opt/android-sdk';
    mocks.safeExecResult.mockImplementation((command: string, args: string[]) => {
      if (command === 'which') return { stdout: `/usr/bin/${args[0]}\n`, stderr: '', status: 0 };
      if (command === 'adb')
        return {
          stdout: 'List of devices attached\nemulator-5554\tdevice\n',
          stderr: '',
          status: 0,
        };
      return { stdout: '', stderr: '', status: 1 };
    });
    mocks.getSecret.mockReturnValue('SECRET-VALUE');
    const report = runAppPreflight({ platform: 'android', full: true });
    const keystore = report.items.find((entry) => entry.id === 'distribution.android.keystore')!;
    expect(keystore.status).toBe('pass');
    expect(JSON.stringify(report)).not.toContain('SECRET-VALUE');
  });
});
