import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile, safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import { browserRuntimeHelpers } from './browser-runtime-helpers.js';

const TEST_ROOT = pathResolver.sharedTmp(`browser-runtime-session-boundary-${process.pid}`);

afterEach(() => {
  safeRmSync(TEST_ROOT, { recursive: true, force: true });
});

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

  it('loads persisted session metadata through the runtime schema', () => {
    const metadataPath = `${TEST_ROOT}/valid-session.json`;
    safeWriteFile(metadataPath, JSON.stringify({ session_id: 'session-1' }), {
      mkdir: true,
    });

    expect(browserRuntimeHelpers.loadBrowserSessionMetadata(metadataPath)).toEqual({
      session_id: 'session-1',
    });
  });

  it('ignores schema-invalid persisted session metadata', () => {
    const metadataPath = `${TEST_ROOT}/invalid-session.json`;
    safeWriteFile(metadataPath, JSON.stringify({ tabs: 'not-an-array' }), {
      mkdir: true,
    });

    expect(browserRuntimeHelpers.loadBrowserSessionMetadata(metadataPath)).toBeNull();
  });
});
