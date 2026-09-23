import { describe, expect, it } from 'vitest';
import {
  assertPluginGrantAllows,
  assertSandboxNetworkAllowed,
  assertSandboxWriteAllowed,
  getPluginExecutionContext,
  intersectSandboxPolicies,
  isSandboxNetworkHostAllowed,
  withPluginExecutionFrame,
  requireSandboxEnforcement,
  resolveSandboxPolicy,
  toCodexSandboxPolicy,
  withSandboxPolicy,
} from './sandbox-policy.js';
import { evaluateEgressPolicy } from './egress-policy.js';
import { validatePipelineGuardrails } from './adf-guardrails.js';
import { validateUrl } from './secure-io.js';
import { executeAdfSteps } from './adf-engine.js';

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

  it('applies one active policy to local writes and direct URL validation', () => {
    const policy = resolveSandboxPolicy({
      provider: 'codex',
      mode: 'workspace-write',
      networkAccess: false,
      writableRoots: ['/workspace/project'],
    });

    withSandboxPolicy(policy, () => {
      expect(() => assertSandboxWriteAllowed('/workspace/project/result.json')).not.toThrow();
      expect(() => assertSandboxWriteAllowed('/workspace/other/result.json')).toThrow(
        'SANDBOX_WRITE_DENIED'
      );
      expect(() => assertSandboxNetworkAllowed('https://example.com')).toThrow(
        'SANDBOX_NETWORK_DENIED'
      );
      expect(() => validateUrl('https://example.com')).toThrow('SANDBOX_NETWORK_DENIED');
      expect(evaluateEgressPolicy('https://example.com')).toMatchObject({
        verdict: 'deny',
        reason: expect.stringContaining('SANDBOX_NETWORK_DENIED'),
      });
    });
  });

  it('makes ADF guardrails reject a partial or network-disabled sandbox before hooks run', () => {
    const partial = resolveSandboxPolicy({ provider: 'agy', mode: 'read-only' });
    const partialReport = validatePipelineGuardrails({ steps: [] }, 'sandbox-test', {
      sandboxPolicy: partial,
    });
    expect(partialReport).toMatchObject({ ok: false });
    expect(partialReport.findings).toContainEqual(
      expect.objectContaining({ code: 'sandbox-enforcement-partial' })
    );

    const networkDisabled = resolveSandboxPolicy({
      provider: 'codex',
      mode: 'workspace-write',
      networkAccess: false,
    });
    const report = validatePipelineGuardrails(
      {
        steps: [
          {
            op: 'demo:step',
            params: {},
            hooks: { before: [{ type: 'http', url: 'https://example.com/health' }] },
          },
        ],
      },
      'sandbox-test',
      { sandboxPolicy: networkDisabled }
    );
    expect(report.findings).toContainEqual(
      expect.objectContaining({ code: 'sandbox-network-denied' })
    );
  });

  it('keeps the active policy installed while an ADF handler executes', async () => {
    const policy = resolveSandboxPolicy({
      provider: 'codex',
      mode: 'workspace-write',
      networkAccess: false,
    });
    const result = await executeAdfSteps(
      [{ type: 'apply', op: 'demo:network', params: {} }],
      {},
      { sandboxPolicy: policy },
      {
        capture: async () => ({}),
        transform: async () => ({}),
        apply: async () => {
          validateUrl('https://example.com');
        },
      }
    );
    expect(result.status).toBe('failed');
    expect(result.results[0]).toMatchObject({ status: 'failed' });
    expect(result.results[0]?.error).toContain('SANDBOX_NETWORK_DENIED');
  });
});

describe('sandbox-policy network allowlist and intersection (EP-03)', () => {
  const grant = (ops: string[]) => ({
    network: { mode: 'none' as const, hosts: [] },
    fs: { mode: 'none' as const, paths: [] },
    ops_invoke: ops,
    env: [],
    secrets: [],
  });

  it('limits network access to allowlisted hosts and fails closed without a host', () => {
    const policy = {
      ...resolveSandboxPolicy({ mode: 'read-only', networkAccess: true }),
      networkAllowlist: ['api.example.com', '*.cdn.example.com', '127.0.0.1', '::1'],
    };
    withSandboxPolicy(policy, () => {
      expect(() => assertSandboxNetworkAllowed('https://api.example.com/v1')).not.toThrow();
      expect(() => assertSandboxNetworkAllowed('https://a.cdn.example.com/x')).not.toThrow();
      expect(() => assertSandboxNetworkAllowed('http://[::1]:8080/')).not.toThrow();
      expect(() => assertSandboxNetworkAllowed('https://cdn.example.com/x')).toThrow(
        '[SANDBOX_NETWORK_DENIED]'
      );
      expect(() => assertSandboxNetworkAllowed('https://evil.example.org')).toThrow(
        '[SANDBOX_NETWORK_DENIED]'
      );
      expect(() => assertSandboxNetworkAllowed()).toThrow('[SANDBOX_NETWORK_DENIED]');
      expect(() => assertSandboxNetworkAllowed('not a url')).toThrow('[SANDBOX_NETWORK_DENIED]');
      expect(() => validateUrl('https://evil.example.org')).toThrow('SANDBOX_NETWORK_DENIED');
      expect(isSandboxNetworkHostAllowed('api.example.com')).toBe(true);
      expect(isSandboxNetworkHostAllowed('evil.example.org')).toBe(false);
    });
  });

  it('never widens the outer policy on any axis', () => {
    const readOnly = resolveSandboxPolicy({ mode: 'read-only', networkAccess: false });
    const wide = {
      ...resolveSandboxPolicy({
        mode: 'workspace-write',
        networkAccess: true,
        writableRoots: ['/repo/knowledge/public'],
      }),
      networkAllowlist: ['*'],
    };
    expect(intersectSandboxPolicies(readOnly, wide)).toMatchObject({
      mode: 'read-only',
      networkAccess: false,
    });

    const outer = {
      ...resolveSandboxPolicy({
        mode: 'workspace-write',
        networkAccess: true,
        writableRoots: ['/repo/knowledge/public/a'],
      }),
      networkAllowlist: ['*.example.com'],
    };
    const inner = {
      ...resolveSandboxPolicy({
        mode: 'workspace-write',
        networkAccess: true,
        writableRoots: ['/repo/knowledge/public', '/repo/active'],
      }),
      networkAllowlist: ['api.example.com', 'other.org'],
    };
    const both = intersectSandboxPolicies(outer, inner);
    expect(both).toMatchObject({
      mode: 'workspace-write',
      writableRoots: ['/repo/knowledge/public/a'],
      networkAccess: true,
      networkAllowlist: ['api.example.com'],
    });

    const disjoint = intersectSandboxPolicies(
      outer,
      resolveSandboxPolicy({ mode: 'workspace-write', writableRoots: ['/elsewhere'] })
    );
    expect(disjoint.mode).toBe('read-only');
    expect(disjoint.networkAccess).toBe(false);

    const noHosts = intersectSandboxPolicies(outer, {
      ...inner,
      networkAllowlist: ['other.org'],
    });
    expect(noHosts.networkAccess).toBe(false);
    expect(noHosts.networkAllowlist).toBeUndefined();

    const partial = resolveSandboxPolicy({ provider: 'agy', mode: 'read-only' });
    expect(intersectSandboxPolicies(partial, readOnly).enforcement).toBe('partial');
  });

  it('danger-full-access outer adopts the inner restriction', () => {
    const outer = resolveSandboxPolicy({ mode: 'danger-full-access', networkAccess: true });
    const inner = resolveSandboxPolicy({
      mode: 'workspace-write',
      writableRoots: ['/repo/knowledge/public'],
      networkAccess: false,
    });
    expect(intersectSandboxPolicies(outer, inner)).toMatchObject({
      mode: 'workspace-write',
      writableRoots: ['/repo/knowledge/public'],
      networkAccess: false,
    });
  });

  it('checks every enclosing plugin frame', () => {
    expect(getPluginExecutionContext()).toBeUndefined();
    expect(() => assertPluginGrantAllows('ops_invoke', 'x:y')).not.toThrow();
    withPluginExecutionFrame({ pluginId: 'outer', grant: grant(['x:*']) }, () => {
      expect(() => assertPluginGrantAllows('ops_invoke', 'x:y')).not.toThrow();
      withPluginExecutionFrame({ pluginId: 'inner', grant: grant(['*']) }, () => {
        expect(getPluginExecutionContext()?.chain.map((frame) => frame.pluginId)).toEqual([
          'outer',
          'inner',
        ]);
        expect(() => assertPluginGrantAllows('ops_invoke', 'z:y')).toThrow(
          "[PLUGIN_GRANT_DENIED] plugin 'outer' is not granted ops_invoke 'z:y'"
        );
      });
    });
  });
});
