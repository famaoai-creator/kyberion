import { describe, expect, it, vi } from 'vitest';
import { currentExecutionScope } from '@agent/core/foundation';
import { extractPrerequisitesOptionFromArgv } from './mission-cli-args.js';
import {
  resolveMissionStartCreateInputFromArgv,
  withMissionCliTenant,
} from './mission-controller-args.js';

describe('mission CLI tenant binding', () => {
  it('keeps the named tenant bound across asynchronous lifecycle work', async () => {
    vi.stubEnv('KYBERION_TENANT', undefined);
    try {
      await withMissionCliTenant(
        'review-task',
        ['review-task', 'MSN-TEST', '--tenant-slug', 'tenant-a'],
        async () => {
          await Promise.resolve();
          expect(currentExecutionScope()).toMatchObject({
            tenantBound: true,
            tenantSlug: 'tenant-a',
          });
        }
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('rejects a conflicting tenant before invoking the lifecycle handler', () => {
    vi.stubEnv('KYBERION_TENANT', 'tenant-b');
    try {
      const run = vi.fn();
      expect(() =>
        withMissionCliTenant('finish', ['finish', 'MSN-TEST', '--tenant-slug', 'tenant-a'], run)
      ).toThrow('ROLE_TENANT_SCOPE_MISMATCH');
      expect(run).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

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
