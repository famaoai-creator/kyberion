import { describe, expect, it } from 'vitest';
import { extractPrerequisitesOptionFromArgv } from './mission-cli-args.js';
import { resolveMissionStartCreateInputFromArgv } from './mission-controller-args.js';

// Regression: start/create resolved relationships through normalizeRelationships,
// which kept only project/track from the named options, so --prerequisites and
// --relationships-json prerequisites never reached the mission.
describe('mission CLI prerequisites', () => {
  const base = ['node', 'mission_controller.js', 'start', 'MSN-CHILD', '--tier', 'public'];

  it('parses --prerequisites into normalized ids', () => {
    expect(extractPrerequisitesOptionFromArgv(['--prerequisites', 'msn-a, MSN-A,msn-b'])).toEqual({
      prerequisites: ['MSN-A', 'MSN-B'],
    });
    expect(extractPrerequisitesOptionFromArgv([])).toEqual({});
  });

  it('carries --prerequisites and --relationships-json prerequisites to the resolved input', () => {
    const resolved = resolveMissionStartCreateInputFromArgv([
      ...base,
      '--prerequisites',
      'msn-a',
      '--relationships-json',
      '{"prerequisites":["msn-b"],"blockers":["msn-c"]}',
    ]);
    expect(resolved.relationships).toMatchObject({
      prerequisites: ['MSN-B', 'MSN-A'],
      blockers: ['MSN-C'],
    });
  });
});
