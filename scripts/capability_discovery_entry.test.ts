import { describe, expect, it } from 'vitest';
import {
  discoverCapabilities,
  evaluateCapability,
  formatReport,
} from './capability_discovery_entry.mjs';

describe('capability_discovery_entry', () => {
  it('marks a capability unavailable when platform or binary is missing', () => {
    expect(
      evaluateCapability(
        {
          op: 'video:render',
          platforms: ['darwin'],
          requirements: { bin: ['definitely-missing'] },
        },
        'linux'
      )
    ).toMatchObject({
      op: 'video:render',
      platformMatch: false,
      available: false,
    });
  });

  it('discovers manifest-backed actuators without dist/', () => {
    const report = discoverCapabilities('linux');
    const ids = report.actuators.map((actuator) => actuator.actuatorId);
    expect(ids).toEqual(expect.arrayContaining(['service-actuator', 'working-memory-actuator']));
    expect(report.actuators.length).toBe(32);
    const secret = report.actuators.find((actuator) => actuator.actuatorId === 'secret-actuator');
    expect(secret?.capabilities.some((capability) => capability.available)).toBe(false);
  });

  it('renders a human-readable report', () => {
    const output = formatReport({
      platform: 'linux',
      rootDir: '/repo',
      actuators: [
        {
          actuatorId: 'demo-actuator',
          version: '1.0.0',
          description: 'Demo',
          capabilities: [
            {
              op: 'list',
              platforms: ['linux'],
              platformMatch: true,
              missingBins: [],
              available: true,
            },
          ],
        },
      ],
      errors: [],
    });
    expect(output).toContain('manifest-scan');
    expect(output).toContain('demo-actuator (1.0.0)');
  });
});
