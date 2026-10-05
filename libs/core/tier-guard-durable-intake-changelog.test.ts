import { afterEach, describe, expect, it, vi } from 'vitest';
import { withExecutionContext } from './authority.js';
import { pathResolver } from './path-resolver.js';
import { validateWritePermission } from './tier-guard.js';

const fragment = 'changelog.d/durable-front-desk-diagnostic-execution.md';
afterEach(() => vi.unstubAllEnvs());

describe('revoked one-time durable intake changelog authority', () => {
  it.each(['ecosystem_architect', 'software_developer'])(
    'keeps the exact fragment and broader paths denied to %s',
    (role) => {
      for (const key of ['KYBERION_SUDO', 'KYBERION_TENANT', 'KYBERION_PROJECT_ID', 'MISSION_ID'])
        vi.stubEnv(key, undefined);
      withExecutionContext(role, () => {
        for (const target of [
          fragment,
          fragment + '/child.md',
          fragment + '.extra',
          'changelog.d/another-fragment.md',
          'CHANGELOG.md',
        ]) {
          expect(validateWritePermission(pathResolver.rootResolve(target)).allowed, target).toBe(
            false
          );
        }
      });
    }
  );
});
