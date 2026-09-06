import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import { safeMkdir, safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import {
  discoverCapabilities,
  evaluateCapability,
  formatCapabilityDiscovery,
} from './capability_discovery.js';

describe('capability_discovery', () => {
  it('marks a capability unavailable when its platform or binary requirement is missing', () => {
    const result = evaluateCapability(
      {
        op: 'video:render',
        platforms: ['darwin'],
        requirements: { bin: ['ffmpeg', 'missing-tool'] },
      },
      'linux',
      (bin) => bin === 'ffmpeg'
    );

    expect(result).toEqual({
      op: 'video:render',
      platforms: ['darwin'],
      platformMatch: false,
      missingBins: ['missing-tool'],
      available: false,
    });
  });

  it('renders the shared report in the human-readable format', () => {
    const output = formatCapabilityDiscovery({
      platform: 'darwin',
      rootDir: '/repo',
      actuators: [
        {
          actuatorId: 'demo-actuator',
          version: '1.0.0',
          description: 'Demo actuator',
          capabilities: [
            {
              op: 'execute',
              platforms: ['darwin'],
              platformMatch: true,
              missingBins: [],
              available: true,
            },
          ],
        },
      ],
      errors: [],
    });

    expect(output).toContain('Dynamic Capability Discovery');
    expect(output).toContain('demo-actuator (1.0.0)');
    expect(output).toContain('execute');
  });

  it('skips actuator manifests reached through a symbolic link', () => {
    const root = pathResolver.sharedTmp('capability-discovery-tests');
    const target = path.join(root, 'target', 'manifest.json');
    const linked = path.join(root, 'actuators', 'linked', 'manifest.json');
    safeMkdir(path.dirname(target), { recursive: true });
    safeMkdir(path.dirname(path.dirname(linked)), { recursive: true });
    safeWriteFile(
      target,
      JSON.stringify({
        actuator_id: 'linked',
        version: '1',
        description: 'linked',
        capabilities: [],
      })
    );
    fs.symlinkSync(path.dirname(target), path.dirname(linked), 'dir');

    try {
      const report = discoverCapabilities({ actuatorsDir: path.join(root, 'actuators') });
      expect(report.actuators).toEqual([]);
    } finally {
      fs.unlinkSync(path.dirname(linked));
      safeRmSync(root, { recursive: true, force: true });
    }
  });

  it('uses governed manifests to discover platform and binary requirements', () => {
    const root = pathResolver.sharedTmp('capability-discovery-manifest-tests');
    const manifestPath = path.join(root, 'actuators', 'demo', 'manifest.json');
    safeMkdir(path.dirname(manifestPath), { recursive: true });
    safeWriteFile(
      manifestPath,
      JSON.stringify({
        actuator_id: 'demo-actuator',
        version: '1.0.0',
        capabilities: [
          {
            op: 'render',
            platforms: ['linux'],
            requirements: { bin: ['ffmpeg', 'missing-tool'] },
          },
        ],
      })
    );

    try {
      const report = discoverCapabilities({
        actuatorsDir: path.join(root, 'actuators'),
        platform: 'linux',
        binaryAvailable: (bin) => bin === 'ffmpeg',
      });
      expect(report.errors).toEqual([]);
      expect(report.actuators[0]).toMatchObject({
        actuatorId: 'demo-actuator',
        description: 'No description available.',
        capabilities: [
          {
            op: 'render',
            platformMatch: true,
            missingBins: ['missing-tool'],
            available: false,
          },
        ],
      });
    } finally {
      safeRmSync(root, { recursive: true, force: true });
    }
  });
});
