import { afterEach, describe, expect, it, vi } from 'vitest';
import { withExecutionContext } from './authority.js';
import { pathResolver } from './path-resolver.js';
import { validateWritePermission } from './tier-guard.js';

afterEach(() => vi.unstubAllEnvs());
describe('Apple native bridge source authoring scope', () => {
  it('allows only the approved tools subtree to the architect', () => {
    for (const key of ['KYBERION_SUDO', 'KYBERION_TENANT', 'KYBERION_PROJECT_ID', 'MISSION_ID'])
      vi.stubEnv(key, undefined);
    withExecutionContext(
      'ecosystem_architect',
      () => {
        expect(
          validateWritePermission(
            pathResolver.rootResolve('tools/apple-intelligence-bridge/afm.swift')
          ).allowed
        ).toBe(true);
        for (const target of [
          'tools/other-bridge/main.swift',
          'tools/apple-intelligence-bridge-extra/main.swift',
        ]) {
          expect(validateWritePermission(pathResolver.rootResolve(target)).allowed, target).toBe(
            false
          );
        }
      },
      'ecosystem_architect'
    );
  });
  it('does not grant source editing to a worker', () => {
    vi.stubEnv('KYBERION_SUDO', undefined);
    withExecutionContext(
      'software_developer',
      () => {
        expect(
          validateWritePermission(
            pathResolver.rootResolve('tools/apple-intelligence-bridge/afm.swift')
          ).allowed
        ).toBe(false);
      },
      'worker'
    );
  });
});
