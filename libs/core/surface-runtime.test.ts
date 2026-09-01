import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeRmSync, safeWriteFile } from './secure-io.js';
import { loadSurfaceManifest } from './surface-runtime.js';

const manifestPath = pathResolver.sharedTmp('surface-runtime-manifest-test.json');

afterEach(() => {
  safeRmSync(manifestPath, { force: true });
});

describe('surface runtime manifest loader', () => {
  it('loads a schema-valid snapshot through the governed catalog', () => {
    safeWriteFile(
      manifestPath,
      JSON.stringify({
        $schema: '../schemas/runtime-surface-manifest.schema.json',
        version: 1,
        surfaces: [
          {
            id: 'test-surface',
            kind: 'service',
            description: 'Test surface',
            command: 'node',
          },
        ],
      })
    );

    expect(loadSurfaceManifest(manifestPath)).toMatchObject({
      version: 1,
      surfaces: [{ id: 'test-surface', kind: 'service' }],
    });
  });

  it('rejects schema-invalid snapshots', () => {
    safeWriteFile(manifestPath, JSON.stringify({ version: 1, surfaces: [{}] }));

    expect(() => loadSurfaceManifest(manifestPath)).toThrow('Invalid surface manifest');
  });

  it('preserves parse errors for malformed snapshots', () => {
    safeWriteFile(manifestPath, '{');

    expect(() => loadSurfaceManifest(manifestPath)).toThrow(SyntaxError);
  });
});
