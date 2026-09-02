import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

describe('browser passkey resource boundary', () => {
  it('revalidates the provider catalog before loading it', () => {
    const source = String(
      safeReadFile(
        pathResolver.rootResolve('libs/actuators/browser-actuator/src/browser-passkey-helpers.ts'),
        { encoding: 'utf8' }
      )
    );

    expect(source).toContain('const passkeyProviderCatalogPath = assertSafeRepositoryPath(');
    expect(source).toContain('{ allowMissingLeaf: true }');
    expect(source).toContain('safeLstat(passkeyProviderCatalogPath).isFile()');
    expect(source).toContain('readJson<');
  });
});
