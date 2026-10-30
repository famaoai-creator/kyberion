import { afterEach, describe, it, expect, vi } from 'vitest';
import { withExecutionContext } from './authority.js';
import { pathResolver } from './path-resolver.js';
import { validateWritePermission } from './tier-guard.js';
afterEach(() => vi.unstubAllEnvs());
describe('governed perception changelog authoring', () => {
  it('keeps developer writes denied and permits the existing changelog owner', () => {
    for (const key of ['KYBERION_SUDO', 'KYBERION_TENANT', 'KYBERION_PROJECT_ID', 'MISSION_ID'])
      vi.stubEnv(key, undefined);
    const target = pathResolver.rootResolve('changelog.d/grounded-perception.md');
    for (const role of ['ecosystem_architect', 'software_developer'])
      withExecutionContext(role, () =>
        expect(validateWritePermission(target).allowed, role).toBe(false)
      );
    withExecutionContext('assemble_changelog', () =>
      expect(validateWritePermission(target).allowed).toBe(true)
    );
  });
});
