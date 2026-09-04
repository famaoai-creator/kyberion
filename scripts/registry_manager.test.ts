import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { pathResolver } from '@agent/core/path-resolver';
import { safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from '@agent/core/secure-io';

import { loadAdapterPayloadAtPath, loadCapabilityRegistryAtPath } from './registry_manager.js';

const fixtureDir = pathResolver.sharedTmp(`registry-manager-loader-${process.pid}`);

const harnessPayload = {
  capability_id: 'cli.native.test',
  source: { type: 'cli_native', provider: 'test', name: 'test-cli', version: 'v1' },
  kind: 'deterministic_utility',
  interaction_mode: 'deterministic_task',
  risk_class: 'low',
  replayability: 'deterministic',
  approval_hooks: { requires_pre_approval: false, approval_scope: 'none' },
  preferred_usage: { workflow_shapes: ['direct_reply'], intents: ['test'] },
  fallback_path: { mode: 'none', target: 'none' },
  status: 'experimental',
};

describe('registry manager catalog boundaries', () => {
  beforeAll(() => safeMkdir(fixtureDir, { recursive: true }));
  afterAll(() => safeRmSync(fixtureDir, { recursive: true, force: true }));

  it('loads harness and gateway adapters through their dedicated schemas', () => {
    const harnessPath = pathResolver.sharedTmp(
      `registry-manager-loader-${process.pid}/harness.json`
    );
    const gatewayPath = pathResolver.sharedTmp(
      `registry-manager-loader-${process.pid}/gateway.json`
    );
    safeWriteFile(harnessPath, JSON.stringify(harnessPayload));
    safeWriteFile(
      gatewayPath,
      JSON.stringify({
        adapter_id: 'test.gateway',
        provider: 'test',
        capability_id: 'gateway.test',
        auth_profile: { type: 'none' },
        status: 'experimental',
      })
    );

    expect(loadAdapterPayloadAtPath(harnessPath, 'harness')).toEqual(harnessPayload);
    expect(loadAdapterPayloadAtPath(gatewayPath, 'gateway')).toMatchObject({
      adapter_id: 'test.gateway',
      capability_id: 'gateway.test',
    });
  });

  it('rejects an adapter that is outside its declared contract', () => {
    const invalidPath = pathResolver.sharedTmp(
      `registry-manager-loader-${process.pid}/invalid.json`
    );
    safeWriteFile(invalidPath, JSON.stringify({ ...harnessPayload, unexpected: true }));

    expect(() => loadAdapterPayloadAtPath(invalidPath, 'harness')).toThrow(
      'Invalid catalog registry-manager-harness-adapter'
    );
  });

  it('loads both persisted registry types through their registry schemas', () => {
    const harnessRegistry = loadCapabilityRegistryAtPath(
      pathResolver.knowledge('product/governance/harness-capability-registry.json'),
      'harness'
    );
    const gatewayRegistry = loadCapabilityRegistryAtPath(
      pathResolver.knowledge('product/governance/gateway-capability-registry.json'),
      'gateway'
    );

    expect(harnessRegistry.capabilities.length).toBeGreaterThan(0);
    expect(gatewayRegistry.capabilities).toEqual(expect.any(Array));
  });

  it('keeps registration output behind the shared printer boundary', () => {
    const source = String(safeReadFile(pathResolver.rootResolve('scripts/registry_manager.ts')));

    expect(source).toContain('print: Print');
    expect(source).not.toContain('console.log');
  });
});
