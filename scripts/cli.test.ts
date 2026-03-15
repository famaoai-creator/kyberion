import { describe, expect, it } from 'vitest';
import { extractBranchArg, normalizeActuators, searchActuators } from './cli.js';

describe('Kyberion CLI helpers', () => {
  it('normalizes compact actuator index entries', () => {
    const actuators = normalizeActuators({
      s: [{ n: 'file-actuator', path: 'libs/actuators/file-actuator', d: 'File operations', s: 'implemented' }],
    });

    expect(actuators).toEqual([
      {
        name: 'file-actuator',
        path: 'libs/actuators/file-actuator',
        description: 'File operations',
        status: 'implemented',
      },
    ]);
  });

  it('searches name, description, and path', () => {
    const actuators = normalizeActuators({
      s: [
        { n: 'browser-actuator', path: 'libs/actuators/browser-actuator', d: 'Playwright web automation', s: 'implemented' },
        { n: 'service-actuator', path: 'libs/actuators/service-actuator', d: 'External SaaS connectors', s: 'implemented' },
      ],
    });

    expect(searchActuators(actuators, 'playwright').map(actuator => actuator.name)).toEqual(['browser-actuator']);
    expect(searchActuators(actuators, 'service-actuator').map(actuator => actuator.name)).toEqual(['service-actuator']);
  });

  it('extracts and removes the branch option from forwarded args', () => {
    const result = extractBranchArg(['--branch', 'ceo-mode', '--', '--help']);

    expect(result).toEqual({
      branchId: 'ceo-mode',
      args: ['--', '--help'],
    });
  });
});
