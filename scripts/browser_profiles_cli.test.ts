import { describe, expect, it, vi } from 'vitest';
import { main, openProfileUrl } from './browser_profiles_cli.js';
import type { BrowserProfile } from '../libs/actuators/browser-actuator/src/browser-profile-manager.js';
import * as secureIo from '@agent/core/secure-io';

describe('browser_profiles_cli', () => {
  it('outputs profile list as JSON when --json is provided', async () => {
    const outputs: string[] = [];
    const print = (msg: string) => outputs.push(msg);

    await main(['profiles', '--json'], print);

    expect(outputs.length).toBeGreaterThan(0);
    const parsed = JSON.parse(outputs[0]);
    expect(Array.isArray(parsed)).toBe(true);
  });

  it('calls safeExecResultAsync with open on macOS for Chrome profile', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin' });

    const safeExecSpy = vi
      .spyOn(secureIo, 'safeExecResultAsync')
      .mockResolvedValue({ status: 0, stdout: '', stderr: '' });

    const mockProfile: BrowserProfile = {
      id: 'Profile 1',
      provider: 'chrome',
      name: 'Ichimura',
      userDataDir: '/Users/fake/Chrome',
      profileDirectory: 'Profile 1',
      status: 'active',
    };

    const prints: string[] = [];
    await openProfileUrl(mockProfile, 'https://example.com', { print: (m) => prints.push(m) });

    expect(safeExecSpy).toHaveBeenCalledWith('open', [
      '-b',
      'com.google.Chrome',
      '--args',
      '--profile-directory=Profile 1',
      'https://example.com',
    ]);

    Object.defineProperty(process, 'platform', { value: originalPlatform });
    safeExecSpy.mockRestore();
  });
});
