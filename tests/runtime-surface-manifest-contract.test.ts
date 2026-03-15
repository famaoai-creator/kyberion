import { describe, expect, it } from 'vitest';
import Ajv from 'ajv';
import * as path from 'node:path';
import { safeReadFile } from '../libs/core/index.js';
import { loadSurfaceManifest, normalizeSurfaceDefinition, surfaceResourceId } from '../libs/core/surface-runtime.js';

const rootDir = process.cwd();

describe('Runtime surface manifest contract', () => {
  it('validates the active surface manifest against schema', () => {
    const schema = JSON.parse(
      safeReadFile(path.join(rootDir, 'knowledge/public/schemas/runtime-surface-manifest.schema.json'), { encoding: 'utf8' }) as string,
    );
    const manifest = JSON.parse(
      safeReadFile(path.join(rootDir, 'knowledge/public/governance/active-surfaces.json'), { encoding: 'utf8' }) as string,
    );
    const ajv = new Ajv({ allErrors: true });
    const validate = ajv.compile(schema);
    const valid = validate(manifest);
    expect(valid, ajv.errorsText(validate.errors)).toBe(true);
  });

  it('covers standard background surfaces with explicit kinds', () => {
    const manifest = loadSurfaceManifest(path.join(rootDir, 'knowledge/public/governance/active-surfaces.json'));
    const ids = new Set(manifest.surfaces.map((entry) => entry.id));
    expect(ids.has('slack-bridge')).toBe(true);
    expect(ids.has('chronos-mirror-v2')).toBe(true);
    expect(ids.has('nexus-daemon')).toBe(true);
    expect(ids.has('terminal-bridge')).toBe(true);
  });

  it('normalizes surfaces to explicit runtime metadata', () => {
    const manifest = loadSurfaceManifest(path.join(rootDir, 'knowledge/public/governance/active-surfaces.json'));
    const chronos = normalizeSurfaceDefinition(
      manifest.surfaces.find((entry) => entry.id === 'chronos-mirror-v2')!,
    );
    expect(chronos.kind).toBe('ui');
    expect(chronos.startupMode).toBe('workspace-app');
    expect(chronos.shutdownPolicy).toBe('detached');
    expect(surfaceResourceId(chronos.id)).toBe('surface:chronos-mirror-v2');
  });
});
