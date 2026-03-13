import { describe, expect, it } from 'vitest';
import { extractBranchArg, normalizeSkills, searchSkills } from './cli.js';

describe('Kyberion CLI helpers', () => {
  it('normalizes compact skill index entries', () => {
    const skills = normalizeSkills({
      s: [{ n: 'file-actuator', path: 'libs/actuators/file-actuator', d: 'File operations', s: 'implemented' }],
    });

    expect(skills).toEqual([
      {
        name: 'file-actuator',
        path: 'libs/actuators/file-actuator',
        description: 'File operations',
        status: 'implemented',
      },
    ]);
  });

  it('searches name, description, and path', () => {
    const skills = normalizeSkills({
      s: [
        { n: 'browser-actuator', path: 'libs/actuators/browser-actuator', d: 'Playwright web automation', s: 'implemented' },
        { n: 'service-actuator', path: 'libs/actuators/service-actuator', d: 'External SaaS connectors', s: 'implemented' },
      ],
    });

    expect(searchSkills(skills, 'playwright').map(skill => skill.name)).toEqual(['browser-actuator']);
    expect(searchSkills(skills, 'service-actuator').map(skill => skill.name)).toEqual(['service-actuator']);
  });

  it('extracts and removes the branch option from forwarded args', () => {
    const result = extractBranchArg(['--branch', 'ceo-mode', '--', '--help']);

    expect(result).toEqual({
      branchId: 'ceo-mode',
      args: ['--', '--help'],
    });
  });
});
