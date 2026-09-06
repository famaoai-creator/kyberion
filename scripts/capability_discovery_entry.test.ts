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
    expect(secret?.capabilities.every((capability) => capability.platformMatch)).toBe(true);
    expect(
      secret?.capabilities.every((capability) =>
        capability.missingEnv.includes('KYBERION_ALLOW_FILE_SECRETS')
      )
    ).toBe(true);
  });

  it('requires KYBERION_ALLOW_FILE_SECRETS only on linux', () => {
    expect(
      evaluateCapability(
        {
          op: 'get',
          platforms: ['darwin', 'win32', 'linux'],
          requirements: { env: ['KYBERION_ALLOW_FILE_SECRETS'], env_platforms: ['linux'] },
        },
        'linux',
        {}
      )
    ).toMatchObject({
      platformMatch: true,
      missingEnv: ['KYBERION_ALLOW_FILE_SECRETS'],
      available: false,
    });
    expect(
      evaluateCapability(
        {
          op: 'get',
          platforms: ['darwin', 'win32', 'linux'],
          requirements: { env: ['KYBERION_ALLOW_FILE_SECRETS'], env_platforms: ['linux'] },
        },
        'darwin',
        {}
      )
    ).toMatchObject({
      platformMatch: true,
      missingEnv: [],
      available: true,
    });
    expect(
      evaluateCapability(
        {
          op: 'get',
          platforms: ['darwin', 'win32', 'linux'],
          requirements: { env: ['KYBERION_ALLOW_FILE_SECRETS'], env_platforms: ['linux'] },
        },
        'linux',
        { KYBERION_ALLOW_FILE_SECRETS: '1' }
      )
    ).toMatchObject({
      available: true,
      missingEnv: [],
    });
  });

  it('renders missing env in the human-readable report', () => {
    const output = formatReport({
      platform: 'linux',
      rootDir: '/repo',
      actuators: [
        {
          actuatorId: 'secret-actuator',
          version: '1.1.0',
          description: 'secrets',
          capabilities: [
            {
              op: 'get',
              platforms: ['linux'],
              platformMatch: true,
              missingBins: [],
              missingEnv: ['KYBERION_ALLOW_FILE_SECRETS'],
              available: false,
            },
          ],
        },
      ],
      errors: [],
    });
    expect(output).toContain('Missing env: KYBERION_ALLOW_FILE_SECRETS');
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
              missingEnv: [],
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
