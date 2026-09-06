import { describe, expect, it } from 'vitest';
import {
  assertSandboxNetworkAllowed,
  assertSandboxWriteAllowed,
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
