import { afterEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { pathResolver, safeExistsSync, safeReadFile, safeRmSync, safeMkdir } from '@agent/core';
import { createActuatorScaffold } from './create_actuator.js';

describe('create_actuator', () => {
  const tmpRoot = pathResolver.sharedTmp('create-actuator-tests');

  afterEach(() => {
    safeRmSync(tmpRoot, { recursive: true, force: true });
  });

  it('creates a scaffold with a schema stub and secure template', () => {
    safeMkdir(tmpRoot);

    const result = createActuatorScaffold({
      name: 'sample-feature',
      description: 'Sample feature actuator',
      rootDir: tmpRoot,
    });

    const outDir = path.join(tmpRoot, 'libs', 'actuators', 'sample-feature-actuator');
    const schemaPath = path.join(outDir, 'schemas', 'sample-feature-action.schema.json');
    const indexPath = path.join(outDir, 'src', 'index.ts');
    const manifestPath = path.join(outDir, 'manifest.json');

    expect(result.outDir).toBe(outDir);
    expect(result.files).toContain('schemas/sample-feature-action.schema.json');
    expect(safeExistsSync(schemaPath)).toBe(true);
    expect(safeExistsSync(indexPath)).toBe(true);
    expect(safeExistsSync(manifestPath)).toBe(true);

    const indexSource = String(safeReadFile(indexPath, { encoding: 'utf8' }));
    const schemaSource = String(safeReadFile(schemaPath, { encoding: 'utf8' }));
    const manifestSource = String(safeReadFile(manifestPath, { encoding: 'utf8' }));

    expect(indexSource).not.toContain('TODO: implement');
    expect(indexSource).not.toContain('node:fs');
    expect(indexSource).toContain('received_params');
    expect(schemaSource).toContain('"execute"');
    expect(manifestSource).toContain('schemas/sample-feature-action.schema.json');
  });

  it('refuses to overwrite an existing actuator directory', () => {
    safeMkdir(tmpRoot);
    const existing = path.join(tmpRoot, 'libs', 'actuators', 'sample-feature-actuator');
    safeMkdir(existing);

    expect(() =>
      createActuatorScaffold({
        name: 'sample-feature',
        rootDir: tmpRoot,
      }),
    ).toThrow(`Directory already exists: ${existing}`);
  });
});
