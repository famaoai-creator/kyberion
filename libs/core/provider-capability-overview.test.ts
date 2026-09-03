import { afterEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';
import {
  buildProviderCapabilitySnapshot,
  loadProviderCapabilitySnapshotAtPath,
  parseProviderCapabilitySnapshot,
} from './provider-capability-overview.js';
import type {
  CapabilityRegistry,
  DiscoveredCapability,
  ProbeResult,
} from './provider-capability-scanner.js';
import type { ProviderInfo } from './provider-discovery.js';

const snapshotRoot = pathResolver.sharedTmp(`provider-capability-overview-${process.pid}`);

afterEach(() => {
  safeRmSync(snapshotRoot, { recursive: true, force: true });
});

describe('provider-capability-overview', () => {
  it('builds a stable snapshot from discovered capabilities and provider status', () => {
    const registry: CapabilityRegistry = {
      version: '1',
      capabilities: [
        {
          capability_id: 'cap.one',
          source: { type: 'cli_native', provider: 'alpha', name: 'one', version: '1' },
          kind: 'reasoning',
          interaction_mode: 'threaded',
          risk_class: 'low',
          replayability: 'deterministic',
          approval_hooks: { requires_pre_approval: false, approval_scope: 'none' },
          preferred_usage: { workflow_shapes: ['chat'], intents: ['intent-a'] },
          fallback_path: { mode: 'manual', target: 'alpha one' },
          status: 'active',
        },
        {
          capability_id: 'cap.two',
          source: { type: 'cli_native', provider: 'beta', name: 'two', version: '1' },
          kind: 'delegated_execution',
          interaction_mode: 'threaded',
          risk_class: 'medium',
          replayability: 'best_effort',
          approval_hooks: { requires_pre_approval: true, approval_scope: 'mission' },
          preferred_usage: { workflow_shapes: ['board'], intents: ['intent-b'] },
          fallback_path: { mode: 'manual', target: 'beta two' },
          status: 'experimental',
        },
      ],
    };

    const discovered: DiscoveredCapability[] = [
      {
        ...registry.capabilities[0],
        discovery_status: 'available',
        provider_probe: {
          provider: 'alpha',
          ok: true,
          evidence: 'alpha --help',
          command: 'alpha',
          args: ['--help'],
        } satisfies ProbeResult,
        evidence: 'alpha evidence',
      },
      {
        ...registry.capabilities[1],
        discovery_status: 'missing',
        provider_probe: {
          provider: 'beta',
          ok: false,
          evidence: 'beta --help',
          command: 'beta',
          args: ['--help'],
          error: 'not installed',
        } satisfies ProbeResult,
      },
    ];

    const providerAvailability = new Map<string, ProbeResult>([
      ['alpha', discovered[0].provider_probe],
      ['beta', discovered[1].provider_probe],
    ]);

    const providers: ProviderInfo[] = [
      {
        provider: 'alpha',
        installed: true,
        version: '1.2.3',
        protocol: 'json-rpc',
        models: [],
        healthy: true,
      },
      {
        provider: 'beta',
        installed: false,
        version: null,
        protocol: 'print-json',
        models: [],
        healthy: false,
      },
    ];

    const snapshot = buildProviderCapabilitySnapshot({
      registry,
      discovered,
      providerAvailability,
      providers,
      generatedAt: '2026-05-26T00:00:00.000Z',
    });

    expect(snapshot).toMatchObject({
      generated_at: '2026-05-26T00:00:00.000Z',
      registered_capabilities: 2,
      available_capabilities: 2,
      available_providers: ['alpha'],
      missing_providers: ['beta'],
      providers: [
        {
          provider: 'alpha',
          installed: true,
          version: '1.2.3',
          protocol: 'json-rpc',
          healthy: true,
        },
        {
          provider: 'beta',
          installed: false,
          version: null,
          protocol: 'print-json',
          healthy: false,
        },
      ],
    });
    expect(snapshot.capabilities.map((capability) => capability.capability_id)).toEqual([
      'cap.one',
      'cap.two',
    ]);
    expect(parseProviderCapabilitySnapshot(snapshot)).toEqual(snapshot);
  });

  it('rejects polluted or structurally invalid persisted snapshots', () => {
    expect(() =>
      parseProviderCapabilitySnapshot({
        generated_at: '2026-05-26T00:00:00.000Z',
        registered_capabilities: 1,
        available_capabilities: 1,
        available_providers: [],
        missing_providers: [],
        providers: [],
        capabilities: [],
        unexpected: true,
      })
    ).toThrow('contains unknown field(s)');
    expect(() =>
      parseProviderCapabilitySnapshot(
        JSON.parse(
          '{"generated_at":"2026-05-26T00:00:00.000Z","registered_capabilities":1,"available_capabilities":1,"available_providers":[],"missing_providers":[],"providers":[{"provider":"alpha","installed":true,"version":null,"protocol":"json-rpc","healthy":true,"__proto__":{}}],"capabilities":[]}'
        )
      )
    ).toThrow('dangerous JSON key');
  });

  it('loads persisted snapshots through the schema-bound catalog', () => {
    const snapshotPath = path.join(snapshotRoot, 'provider-capabilities.json');
    safeMkdir(snapshotRoot, { recursive: true });
    safeWriteFile(
      snapshotPath,
      JSON.stringify({
        generated_at: '2026-05-26T00:00:00.000Z',
        registered_capabilities: 0,
        available_capabilities: 0,
        available_providers: [],
        missing_providers: [],
        providers: [],
        capabilities: [],
      })
    );

    expect(loadProviderCapabilitySnapshotAtPath(snapshotPath)).toMatchObject({
      generated_at: '2026-05-26T00:00:00.000Z',
      providers: [],
      capabilities: [],
    });

    safeWriteFile(snapshotPath, JSON.stringify({ providers: [] }));
    expect(() => loadProviderCapabilitySnapshotAtPath(snapshotPath)).toThrow(
      /Invalid catalog provider-capability-snapshot/u
    );
  });
});
