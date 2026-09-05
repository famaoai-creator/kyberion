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

    expect(source).toContain('defineCatalog<PasskeyProviderCatalog>({');
    expect(source).toContain("id: 'browser-passkey-providers'");
    expect(source).toContain('schema: PASSKEY_PROVIDER_SCHEMA_PATH');
    expect(source).toContain('passkeyProviderCatalog.load()');
    expect(source).not.toContain('fallbackOnInvalid: true');
    expect(source).not.toContain('defaultPasskeyProviderCatalog');
  });
});
