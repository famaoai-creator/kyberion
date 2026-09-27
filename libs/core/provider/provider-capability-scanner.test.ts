import { describe, it, expect } from 'vitest';
import {
  type CapabilityRegistry,
  type ProviderScanPolicy,
  loadCapabilityRegistry,
  loadProviderCapabilityScanPolicy,
  scanProviderCapabilities,
} from './provider-capability-scanner.js';

/**
 * Locks in the cross-provider invariant: every provider that has capabilities
 * registered in the harness-capability-registry must also have a primary
 * probe in the provider-capability-scan-policy. Without that pairing, the
 * scanner cannot decide whether a registered capability is locally available.
 *
 * This test deliberately avoids spawning the actual CLI binaries (which would
 * make the test environment-dependent). It validates the registration + policy
 * contract only.
 */
describe('provider-capability-scanner — registry / policy contract', () => {
  const registry = loadCapabilityRegistry();
  const policy = loadProviderCapabilityScanPolicy();

  it('registry and policy each declare a non-empty version', () => {
    expect(registry.version).toBeTruthy();
    expect(policy.version).toBeTruthy();
  });

  it('rejects repository-external override paths before loading them', () => {
    expect(() => loadCapabilityRegistry('../../outside-capability-registry.json')).toThrow(
      '[RESOURCE_PATH_SCOPE]'
    );
    expect(() => loadProviderCapabilityScanPolicy('../../outside-provider-policy.json')).toThrow(
      '[RESOURCE_PATH_SCOPE]'
    );
  });

  it('does not expose a capability when its evidence probe fails', () => {
    const registry = {
      version: '1',
      capabilities: [
        {
          capability_id: 'test.capability',
          source: { type: 'cli_native', provider: 'test-provider', name: 'test', version: '1' },
          kind: 'reasoning',
          interaction_mode: 'request_response',
          risk_class: 'low',
          replayability: 'deterministic',
          approval_hooks: { requires_pre_approval: false, approval_scope: 'none' },
          preferred_usage: { workflow_shapes: ['task_session'], intents: ['test'] },
          fallback_path: { mode: 'local', target: 'test' },
          status: 'active',
        },
      ],
    } satisfies CapabilityRegistry;
    const policy = {
      version: '1',
      providers: [
        {
          provider: 'test-provider',
          primary_probe: { command: 'primary' },
          evidence_probes: [
            { capability_ids: ['test.capability'], probe: { command: 'evidence' } },
          ],
        },
      ],
    } satisfies ProviderScanPolicy;

    const discovered = scanProviderCapabilities(registry, policy, {
      includeUnavailable: true,
      exec: (command) => {
        if (command === 'primary') return 'ready';
        throw new Error('evidence unsupported');
      },
    });

    expect(discovered).toHaveLength(1);
    expect(discovered[0]).toMatchObject({
      discovery_status: 'missing',
      evidence_probe: { ok: false, error: 'evidence unsupported' },
    });
  });

  it('every provider in the registry has a primary probe in the policy', () => {
    const policyProviders = new Set(policy.providers.map((p) => p.provider));
    const missing: string[] = [];
    for (const cap of registry.capabilities) {
      if (!policyProviders.has(cap.source.provider)) {
        missing.push(`${cap.capability_id} → provider ${cap.source.provider}`);
      }
    }
    expect(
      missing,
      `capabilities reference providers without a probe: ${missing.join('; ')}`
    ).toEqual([]);
  });

  it('every evidence_probe references a capability_id that exists in the registry', () => {
    const known = new Set(registry.capabilities.map((c) => c.capability_id));
    const stale: string[] = [];
    for (const provider of policy.providers) {
      for (const ep of provider.evidence_probes ?? []) {
        for (const id of ep.capability_ids) {
          if (!known.has(id)) stale.push(`${provider.provider}: ${id}`);
        }
      }
    }
    expect(stale, `policy references unknown capability_ids: ${stale.join('; ')}`).toEqual([]);
  });

  describe('claude-cli registration', () => {
    const expectedIds = [
      'cli.native.claude_headless_prompt',
      'cli.native.claude_agent_loop',
      'cli.native.claude_agents_management',
      'cli.native.claude_plugin_management',
      'cli.native.claude_mcp_management',
    ];

    it('exposes the expected 5 capabilities under provider claude-cli', () => {
      const claudeCaps = registry.capabilities.filter((c) => c.source.provider === 'claude-cli');
      const ids = claudeCaps.map((c) => c.capability_id).sort();
      expect(ids).toEqual([...expectedIds].sort());
    });

    it('has a primary probe for claude-cli in the scan policy', () => {
      const provider = policy.providers.find((p) => p.provider === 'claude-cli');
      expect(provider, 'claude-cli must appear in provider-capability-scan-policy').toBeTruthy();
      expect(provider!.primary_probe.command).toBe('claude');
    });

    it('has an evidence_probe for each claude-cli capability', () => {
      const provider = policy.providers.find((p) => p.provider === 'claude-cli')!;
      const covered = new Set<string>();
      for (const ep of provider.evidence_probes ?? []) {
        for (const id of ep.capability_ids) covered.add(id);
      }
      const missingProbes = expectedIds.filter((id) => !covered.has(id));
      expect(missingProbes, `evidence_probes missing for: ${missingProbes.join(', ')}`).toEqual([]);
    });

    it('mirrors gemini-cli for headless / agent / plugin / mcp surfaces', () => {
      // Both providers should have headless_prompt / mcp_management at minimum.
      // This is a structural mirror, not a behavioral one — the agents/plugin/etc
      // analogs use the same governance kind/risk_class/approval as gemini's set.
      const claudeKinds = registry.capabilities
        .filter((c) => c.source.provider === 'claude-cli')
        .map((c) => c.kind)
        .sort();
      const geminiKinds = registry.capabilities
        .filter((c) => c.source.provider === 'gemini-cli')
        .map((c) => c.kind)
        .sort();
      // Both should have at least one of each: reasoning, deterministic_utility, delegated_execution
      const requiredKinds = ['reasoning', 'delegated_execution'] as const;
      for (const kind of requiredKinds) {
        expect(claudeKinds, `claude-cli should expose at least one ${kind}`).toContain(kind);
        expect(geminiKinds, `gemini-cli should expose at least one ${kind}`).toContain(kind);
      }
    });
  });

  describe('cli-native provider coverage', () => {
    it('every cli-native provider has at least a primary probe in the policy', () => {
      const cliNativeProviders = [
        ...new Set(
          registry.capabilities
            .filter((c) => c.source.type === 'cli_native')
            .map((c) => c.source.provider)
        ),
      ];
      const missing: string[] = [];
      for (const providerName of cliNativeProviders) {
        const policyEntry = policy.providers.find((p) => p.provider === providerName);
        if (!policyEntry || !policyEntry.primary_probe?.command) {
          missing.push(providerName);
        }
      }
      expect(
        missing,
        `cli_native providers without a primary_probe: ${missing.join(', ')}`
      ).toEqual([]);
    });
  });
});
