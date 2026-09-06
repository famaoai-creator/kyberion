import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

describe('system focus resource boundary', () => {
  it('revalidates the focused-target store before every read and write', () => {
    const source = String(
      safeReadFile(
        pathResolver.rootResolve('libs/actuators/system-actuator/src/system-focus-helpers.ts'),
        { encoding: 'utf8' }
      )
    );

    expect(source).toContain('function safeFocusTargetStorePath(');
    expect(source).toContain('const safeStorePath = safeFocusTargetStorePath(');
    expect(source).toContain('safeFocusTargetStorePath({ allowMissingLeaf: true })');
    expect(source).toContain('focusTargetStoreCatalog.load()');
    expect(source).toContain('focusTargetStoreCatalog.validate(');
    expect(source).not.toContain('readJson');
  });
});
