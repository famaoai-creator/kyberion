import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  capturePipelineResumePolicyEnvironment,
  restorePipelineResumePolicyEnvironment,
} from './pipeline-resume-policy-env.js';

afterEach(() => vi.unstubAllEnvs());

describe('original pipeline policy environment', () => {
  it('captures non-secret policy selectors but never serializes temporary elevation', () => {
    vi.stubEnv('KYBERION_PROVIDER_EGRESS_POLICY_PATH', 'original-strict-policy.json');
    vi.stubEnv('KYBERION_ALLOW_UNSAFE_SHELL', '0');
    vi.stubEnv('KYBERION_SUDO', 'true');
    vi.stubEnv('KYBERION_SUDO_SCOPE', 'all');
    vi.stubEnv('KYBERION_SUDO_KEY', 'temporary-secret');
    vi.stubEnv('KYBERION_CUSTOM_POLICY_PATH', 'unsupported.json');
    const captured = capturePipelineResumePolicyEnvironment();
    expect(captured.policy_env).toMatchObject({
      KYBERION_PROVIDER_EGRESS_POLICY_PATH: 'original-strict-policy.json',
      KYBERION_ALLOW_UNSAFE_SHELL: '0',
    });
    expect(captured.policy_env).not.toHaveProperty('KYBERION_SUDO');
    expect(JSON.stringify(captured)).not.toContain('temporary-secret');
    expect(captured.unsupported_policy_env).toContain('KYBERION_CUSTOM_POLICY_PATH');
  });

  it('removes approving-runtime overrides before restoring exact source selectors', () => {
    const source = capturePipelineResumePolicyEnvironment().policy_env;
    source.KYBERION_PROVIDER_EGRESS_POLICY_PATH = 'original-strict-policy.json';
    source.KYBERION_ALLOW_UNSAFE_SHELL = '0';
    const restored = restorePipelineResumePolicyEnvironment(source, {
      KYBERION_PROVIDER_EGRESS_POLICY_PATH: 'approver-policy.json',
      KYBERION_ALLOW_UNSAFE_SHELL: '1',
      KYBERION_CUSTOM_POLICY_PATH: 'approver-custom.json',
      PATH: '/bin',
    });
    expect(restored).toMatchObject({
      KYBERION_PROVIDER_EGRESS_POLICY_PATH: 'original-strict-policy.json',
      KYBERION_ALLOW_UNSAFE_SHELL: '0',
      PATH: '/bin',
    });
    expect(restored).not.toHaveProperty('KYBERION_CUSTOM_POLICY_PATH');
  });
});
