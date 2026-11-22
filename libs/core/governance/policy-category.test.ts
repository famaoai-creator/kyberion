import { describe, expect, it } from 'vitest';
import {
  evaluatePolicyCategory,
  formatPolicyVerdict,
  allowsAlwaysPrimaryAction,
} from './policy-category.js';

describe('evaluatePolicyCategory', () => {
  it('never denies every category', () => {
    const v = evaluatePolicyCategory({
      category: 'read_file',
      level: 'never',
      platform: 'darwin',
    });
    expect(formatPolicyVerdict(v)).toBe('deny:permission_never');
  });

  it('ask returns permission_ask for ordinary file reads', () => {
    expect(
      formatPolicyVerdict(
        evaluatePolicyCategory({ category: 'read_file', level: 'ask', platform: 'linux' })
      )
    ).toBe('ask:permission_ask');
  });

  it('always allows sandboxed run_command on darwin', () => {
    expect(
      formatPolicyVerdict(
        evaluatePolicyCategory({
          category: 'run_command',
          level: 'always',
          platform: 'darwin',
          sandboxed: true,
        })
      )
    ).toBe('allow:sandboxed_command');
  });

  it('win32 run_command always still asks', () => {
    expect(
      formatPolicyVerdict(
        evaluatePolicyCategory({
          category: 'run_command',
          level: 'always',
          platform: 'win32',
          sandboxed: true,
        })
      )
    ).toBe('ask:windows_requires_approval');
  });

  it('send_out and paid generation never escalate to allow', () => {
    expect(
      formatPolicyVerdict(
        evaluatePolicyCategory({ category: 'send_out', level: 'always', platform: 'darwin' })
      )
    ).toBe('ask:user_send_confirmation');
    expect(allowsAlwaysPrimaryAction('send_out')).toBe(false);
    expect(allowsAlwaysPrimaryAction('image_generation')).toBe(false);
  });

  it('protected paths deny even at always', () => {
    expect(
      formatPolicyVerdict(
        evaluatePolicyCategory({
          category: 'read_file',
          level: 'always',
          platform: 'darwin',
          protected_path: true,
        })
      )
    ).toBe('deny:sensitive_path');
  });
});
