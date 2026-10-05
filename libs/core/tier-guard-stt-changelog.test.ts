import { afterEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { withExecutionContext } from './authority.js';
import { pathResolver } from './path-resolver.js';
import { validateWritePermission } from './tier-guard.js';

const fragment = 'changelog.d/faster-whisper-config-forwarding.md';
afterEach(() => vi.unstubAllEnvs());

describe('revoked one-time faster-whisper changelog permission', () => {
  it('keeps the fragment and descendants denied after one-time authoring', () => {
    for (const key of ['KYBERION_SUDO', 'KYBERION_TENANT', 'KYBERION_PROJECT_ID', 'MISSION_ID'])
      vi.stubEnv(key, undefined);
    withExecutionContext('ecosystem_architect', () => {
      expect(validateWritePermission(path.join(pathResolver.rootDir(), fragment)).allowed).toBe(
        false
      );
      for (const target of [
        fragment + '/child.md',
        'changelog.d/another-change.md',
        fragment + '.extra',
        'changelog.d/faster-whisper-config-forwarding-other.md',
        'CHANGELOG.md',
      ]) {
        expect(
          validateWritePermission(path.join(pathResolver.rootDir(), target)).allowed,
          target
        ).toBe(false);
      }
    });
  });

  it('does not grant the fragment to ordinary workers', () => {
    vi.stubEnv('KYBERION_SUDO', undefined);
    withExecutionContext('software_developer', () => {
      expect(validateWritePermission(path.join(pathResolver.rootDir(), fragment)).allowed).toBe(
        false
      );
    });
  });
});
