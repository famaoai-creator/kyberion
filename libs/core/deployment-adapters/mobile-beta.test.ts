import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ execFileSync: vi.fn() }));
vi.mock('node:child_process', () => ({ execFileSync: mocks.execFileSync }));
vi.mock('../core.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, success: () => {} },
}));

import { MobileBetaDeploymentAdapter } from './mobile-beta.js';

const DEPLOY_INPUT = {
  environment: 'beta',
  projectName: 'FixtureApp',
  version: 'v0.1.0',
};

describe('mobile-beta deployment adapter (E2E-05 Task 6)', () => {
  beforeEach(() => {
    mocks.execFileSync.mockReset();
  });

  it('delegates to fastlane <platform> <lane> in the app repo', async () => {
    mocks.execFileSync.mockReturnValue('ok');
    const adapter = new MobileBetaDeploymentAdapter({
      platform: 'ios',
      projectDir: '/tmp/fixture-app',
    });
    const result = await adapter.deploy(DEPLOY_INPUT);
    expect(result.status).toBe('triggered');
    const lanes = mocks.execFileSync.mock.calls.map((call) => call.slice(0, 2));
    expect(lanes[0]).toEqual(['fastlane', ['--version']]);
    expect(lanes[1]).toEqual(['fastlane', ['ios', 'beta']]);
    expect(mocks.execFileSync.mock.calls[1][2].cwd).toBe('/tmp/fixture-app');
  });

  it('fails with an install hint when fastlane is missing', async () => {
    mocks.execFileSync.mockImplementation(() => {
      throw new Error('command not found: fastlane');
    });
    const adapter = new MobileBetaDeploymentAdapter({
      platform: 'android',
      projectDir: '/tmp/fixture-app',
    });
    const result = await adapter.deploy(DEPLOY_INPUT);
    expect(result.status).toBe('failed');
    expect(result.message).toContain('fastlane is not installed');
    expect(mocks.execFileSync).toHaveBeenCalledTimes(1);
  });

  it('surfaces a missing Fastfile as an actionable error', async () => {
    mocks.execFileSync.mockReturnValueOnce('fastlane 2.220.0').mockImplementationOnce(() => {
      throw new Error('Could not find Fastfile at path');
    });
    const adapter = new MobileBetaDeploymentAdapter({
      platform: 'android',
      projectDir: '/tmp/fixture-app',
      lane: 'beta',
    });
    const result = await adapter.deploy(DEPLOY_INPUT);
    expect(result.status).toBe('failed');
    expect(result.message).toContain('Fastfile not found in /tmp/fixture-app');
  });

  it('never embeds secret values — env passes names through only', async () => {
    mocks.execFileSync.mockReturnValue('ok');
    const adapter = new MobileBetaDeploymentAdapter({
      platform: 'ios',
      projectDir: '/tmp/fixture-app',
      env: { APP_STORE_CONNECT_API_KEY_PATH: 'vault:ios-api-key' },
    });
    const result = await adapter.deploy(DEPLOY_INPUT);
    expect(result.status).toBe('triggered');
    expect(JSON.stringify(result)).not.toContain('vault:ios-api-key');
  });
});
