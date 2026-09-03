import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeRmSync, safeWriteFile } from './secure-io.js';
import { loadSurfaceManifest, loadSurfaceState, saveSurfaceState } from './surface-runtime.js';

const manifestPath = pathResolver.sharedTmp('surface-runtime-manifest-test.json');
const statePath = pathResolver.sharedTmp('surface-runtime-state-test.json');

afterEach(() => {
  safeRmSync(manifestPath, { force: true });
  safeRmSync(statePath, { force: true });
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

describe('surface runtime state catalog', () => {
  const validState = {
    version: 1 as const,
    surfaces: {
      'test-surface': {
        id: 'test-surface',
        pid: 1234,
        resourceId: 'surface:test-surface',
        kind: 'service' as const,
        command: 'node',
        args: [],
        cwd: pathResolver.rootDir(),
        logPath: pathResolver.sharedTmp('surface-runtime-state-test.log'),
        startedAt: '2026-09-04T00:00:00.000Z',
        shutdownPolicy: 'detached' as const,
        metadata: { source: 'test' },
      },
    },
  };

  it('loads and saves state through the governed catalog', () => {
    saveSurfaceState(validState, statePath);

    expect(loadSurfaceState(statePath)).toEqual(validState);
  });

  it('rejects schema-invalid persisted state before semantic projection', () => {
    safeWriteFile(statePath, JSON.stringify({ ...validState, unexpected: true }));

    expect(() => loadSurfaceState(statePath)).toThrow('Invalid catalog surface-runtime-state');
  });

  it('preserves parse errors for malformed state', () => {
    safeWriteFile(statePath, '{');

    expect(() => loadSurfaceState(statePath)).toThrow(SyntaxError);
  });
});
