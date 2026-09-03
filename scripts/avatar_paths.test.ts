import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';
import { resolveAvatarGenerationPaths } from './generate_avatar.js';
import { normalizeIdentityRecord, resolveAvatarRegistrationPaths } from './register_avatar.js';

describe('avatar script path boundaries', () => {
  it('uses the canonical personal identity loader for updates', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/register_avatar.ts'), { encoding: 'utf8' })
    );
    expect(source).toContain('loadPersonalIdentityAtPath(identityJsonPath)');
    expect(source).not.toContain('readJson');
  });

  it('keeps generation input and output inside the repository', () => {
    const paths = resolveAvatarGenerationPaths(
      'active/shared/tmp/user_face.jpg',
      'active/shared/tmp/avatar.png'
    );

    expect(paths.inputPhoto).toBe(pathResolver.rootResolve('active/shared/tmp/user_face.jpg'));
    expect(paths.outputPath).toBe(pathResolver.rootResolve('active/shared/tmp/avatar.png'));
  });

  it('rejects an external generation output path', () => {
    expect(() =>
      resolveAvatarGenerationPaths(
        'active/shared/tmp/user_face.jpg',
        '../avatar-outside-repository.png'
      )
    ).toThrow('[RESOURCE_PATH_SCOPE]');
  });

  it('keeps registration source, destination, and identity paths scoped', () => {
    const paths = resolveAvatarRegistrationPaths({
      'src-avatar': 'active/shared/tmp/avatar.png',
      'dest-avatar-dir': 'knowledge/personal',
    });

    expect(paths.srcAvatar).toBe(pathResolver.rootResolve('active/shared/tmp/avatar.png'));
    expect(paths.destAvatar).toBe(pathResolver.rootResolve('knowledge/personal/avatar.png'));
    expect(paths.identityJsonPath).toBe(
      pathResolver.rootResolve('knowledge/personal/my-identity.json')
    );
  });

  it('rejects an external identity path before profile mutation', () => {
    expect(() =>
      resolveAvatarRegistrationPaths({
        'identity-path': '/tmp/kyberion-identity.json',
      })
    ).toThrow('[RESOURCE_PATH_SCOPE]');
  });

  it('rejects primitive and array identity roots', () => {
    expect(normalizeIdentityRecord(null)).toBeNull();
    expect(normalizeIdentityRecord([])).toBeNull();
    expect(normalizeIdentityRecord({ name: 'operator' })).toEqual({ name: 'operator' });
  });
});
