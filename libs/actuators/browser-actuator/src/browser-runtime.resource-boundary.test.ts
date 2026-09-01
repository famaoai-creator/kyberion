import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

describe('browser runtime resource boundary', () => {
  it('revalidates persisted artifacts and normalizes session-derived filenames', () => {
    const source = String(
      safeReadFile(
        pathResolver.rootResolve('libs/actuators/browser-actuator/src/browser-runtime-helpers.ts'),
        { encoding: 'utf8' }
      )
    );

    expect(source).toContain('function safeBrowserRuntimePath(');
    expect(source).toContain('return assertSafeRepositoryPath(filePath, options);');
    expect(source).toContain('function browserSessionArtifactPath(');
    expect(source).toContain("replace(/[^a-zA-Z0-9._-]/g, '_')");
    expect(source).toContain('const safePath = safeBrowserRuntimePath(filePath);');
    expect(source).toContain('function isExistingRegularFile(filePath: string): boolean');
    expect(source).toContain('return safeLstat(filePath).isFile();');
    expect(source).toContain('browserSessionArtifactPath(BROWSER_SNAPSHOT_DIR, sessionId');
  });
});
