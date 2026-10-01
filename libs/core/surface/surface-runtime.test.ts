import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver } from '../path-resolver.js';
import { safeMkdir, safeRmSync, safeWriteFile } from '../secure-io.js';
import {
  applySurfaceEnablementOverrides,
  loadSurfaceEnablementOverrides,
  loadSurfaceManifest,
  setSurfaceEnablementOverride,
  loadSurfaceState,
  readSurfaceLogTail,
  saveSurfaceState,
} from './surface-runtime.js';

const manifestPath = pathResolver.sharedTmp('surface-runtime-manifest-test.json');
const statePath = pathResolver.sharedTmp('surface-runtime-state-test.json');
const logPath = pathResolver.sharedTmp('surface-runtime-log-test.log');
const overridesPath = pathResolver.sharedTmp('surface-runtime-overrides-test.json');

afterEach(() => {
  safeRmSync(manifestPath, { force: true });
  safeRmSync(statePath, { force: true });
  safeRmSync(logPath, { recursive: true, force: true });
  safeRmSync(overridesPath, { force: true });
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

  it('rejects a runtime log path replaced by a directory', () => {
    safeMkdir(logPath, { recursive: true });

    expect(() => readSurfaceLogTail(logPath)).toThrow('log must be a regular file');
  });
});

describe('surface enablement overlay (operator state outside the committed registry)', () => {
  const manifest = {
    version: 1 as const,
    surfaces: [
      { id: 'gw', kind: 'gateway' as const, description: 'g', command: 'node', enabled: false },
      { id: 'ui', kind: 'service' as const, description: 'u', command: 'node' },
    ],
  };

  it('treats a missing overlay as no overrides', () => {
    expect(loadSurfaceEnablementOverrides(overridesPath)).toEqual({ version: 1, surfaces: {} });
  });

  it('records deviations from the committed default and drops them when reverted', () => {
    setSurfaceEnablementOverride('gw', true, false, overridesPath);
    setSurfaceEnablementOverride('ui', false, true, overridesPath);
    const overrides = loadSurfaceEnablementOverrides(overridesPath);
    expect(overrides.surfaces.gw?.enabled).toBe(true);
    expect(overrides.surfaces.ui?.enabled).toBe(false);

    const merged = applySurfaceEnablementOverrides(manifest, overrides);
    expect(merged.surfaces.map((s) => [s.id, s.enabled])).toEqual([
      ['gw', true],
      ['ui', false],
    ]);
    expect(manifest.surfaces[0].enabled).toBe(false);

    setSurfaceEnablementOverride('gw', false, false, overridesPath);
    expect(loadSurfaceEnablementOverrides(overridesPath).surfaces.gw).toBeUndefined();
  });

  it('applies the overlay to the canonical registry only unless requested', () => {
    safeWriteFile(manifestPath, JSON.stringify(manifest));
    setSurfaceEnablementOverride('gw', true, false, overridesPath);
    expect(loadSurfaceManifest(manifestPath, { overridesPath }).surfaces[0].enabled).toBe(false);
    expect(
      loadSurfaceManifest(manifestPath, { applyOverrides: true, overridesPath }).surfaces[0].enabled
    ).toBe(true);
  });

  it('ignores an invalid overlay file instead of failing the registry load', () => {
    safeWriteFile(
      overridesPath,
      JSON.stringify({ version: 1, surfaces: { gw: { enabled: 'yes' } } })
    );
    expect(loadSurfaceEnablementOverrides(overridesPath)).toEqual({ version: 1, surfaces: {} });
  });
});
