import { describe, expect, it } from 'vitest';
import Ajv from 'ajv';
import * as path from 'node:path';
import { safeReadFile, safeReaddir, safeExistsSync } from '@agent/core';
import { loadSurfaceManifest, normalizeSurfaceDefinition, surfaceResourceId } from '@agent/core/surface-runtime';

const rootDir = process.cwd();

describe('Runtime surface manifest contract', () => {
  it('validates the canonical per-surface manifests and compatibility snapshot against schema', () => {
    const schema = JSON.parse(
      safeReadFile(path.join(rootDir, 'knowledge/public/schemas/runtime-surface-manifest.schema.json'), { encoding: 'utf8' }) as string,
    );
    const snapshot = JSON.parse(
      safeReadFile(path.join(rootDir, 'knowledge/public/governance/active-surfaces.json'), { encoding: 'utf8' }) as string,
    );
    const ajv = new Ajv({ allErrors: true });
    const validate = ajv.compile(schema);
    const validSnapshot = validate(snapshot);
    expect(validSnapshot, ajv.errorsText(validate.errors)).toBe(true);

    const surfacesDir = path.join(rootDir, 'knowledge/public/governance/surfaces');
    expect(safeExistsSync(surfacesDir)).toBe(true);

    const files = safeReaddir(surfacesDir).filter((entry) => entry.endsWith('.json')).sort();
    expect(files.length).toBeGreaterThan(0);
    const aggregated = { version: 1 as const, surfaces: [] as Array<Record<string, unknown>> };
    for (const file of files) {
      const fileManifest = JSON.parse(
        safeReadFile(path.join(surfacesDir, file), { encoding: 'utf8' }) as string,
      );
      const validFile = validate(fileManifest);
      expect(validFile, ajv.errorsText(validate.errors)).toBe(true);
      expect(Array.isArray(fileManifest.surfaces)).toBe(true);
      expect(fileManifest.surfaces).toHaveLength(1);
      expect(fileManifest.surfaces[0].id).toBe(file.replace(/\.json$/i, ''));
      aggregated.surfaces.push(fileManifest.surfaces[0]);
    }

    const sortById = (items: Array<Record<string, unknown>>) =>
      [...items].sort((left, right) => String(left.id || '').localeCompare(String(right.id || '')));
    expect(sortById(aggregated.surfaces)).toEqual(sortById(snapshot.surfaces || []));
  });

  it('covers standard background surfaces with explicit kinds', () => {
    const manifest = loadSurfaceManifest(path.join(rootDir, 'knowledge/public/governance/active-surfaces.json'));
    const ids = new Set(manifest.surfaces.map((entry) => entry.id));
    expect(ids.has('slack-bridge')).toBe(true);
    expect(ids.has('imessage-bridge')).toBe(true);
    expect(ids.has('discord-bridge')).toBe(true);
    expect(ids.has('telegram-bridge')).toBe(true);
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
