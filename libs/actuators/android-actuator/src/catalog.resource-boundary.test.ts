import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

describe('android catalog resource boundary', () => {
  it('revalidates UI defaults before reading the catalog', () => {
    const source = String(
      safeReadFile(
        pathResolver.rootResolve('libs/actuators/android-actuator/src/android-runtime-helpers.ts'),
        { encoding: 'utf8' }
      )
    );

    expect(source).toContain('defineCatalog<AndroidUiDefaults>({');
    expect(source).toContain("id: 'android-ui-defaults'");
    expect(source).toContain('schema: ANDROID_UI_DEFAULTS_SCHEMA_PATH');
    expect(source).toContain('androidUiDefaultsCatalog.load()');
  });
});
