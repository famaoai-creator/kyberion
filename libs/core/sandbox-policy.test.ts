import { describe, expect, it } from 'vitest';
import {
  requireSandboxEnforcement,
  resolveSandboxPolicy,
  toCodexSandboxPolicy,
} from './sandbox-policy.js';

describe('sandbox-policy (DH-11)', () => {
  it('reports full enforcement for Codex read-only and projects its request shape', () => {
    const policy = resolveSandboxPolicy({
      provider: 'codex',
      mode: 'read-only',
      networkAccess: false,
    });
    expect(policy.enforcement).toBe('full');
    expect(requireSandboxEnforcement(policy)).toBe(policy);
    expect(toCodexSandboxPolicy(policy)).toEqual({ type: 'readOnly', networkAccess: false });
  });

  it('reports partial enforcement for provider approximations and fails closed', () => {
    const policy = resolveSandboxPolicy({ provider: 'agy', mode: 'read-only' });
    expect(policy.enforcement).toBe('partial');
    expect(() => requireSandboxEnforcement(policy)).toThrow('SANDBOX_POLICY_PARTIAL');
  });

  it('keeps workspace roots and network policy in one resolved object', () => {
    const policy = resolveSandboxPolicy({
      provider: 'codex',
      mode: 'workspace-write',
      networkAccess: true,
      writableRoots: ['/workspace/project'],
    });
    expect(toCodexSandboxPolicy(policy)).toMatchObject({
      type: 'workspaceWrite',
      networkAccess: true,
      writableRoots: ['/workspace/project'],
    });
  });
});
