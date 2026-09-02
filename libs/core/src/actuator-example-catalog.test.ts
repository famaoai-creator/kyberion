import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { pathResolver } from '../path-resolver.js';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat, safeReaddir } from '../secure-io.js';
import { loadActuatorExampleCatalog } from './actuator-example-catalog.js';

describe('actuator example catalogs', () => {
  it('loads every actuator catalog through the governed schema boundary', () => {
    const actuatorsDir = assertSafeRepositoryPath(pathResolver.rootResolve('libs/actuators'));
    const catalogs = safeReaddir(actuatorsDir)
      .map((entry) => assertSafeRepositoryPath(path.join(actuatorsDir, entry)))
      .filter((entryPath) => safeLstat(entryPath).isDirectory())
      .map((entryPath) =>
        assertSafeRepositoryPath(path.join(entryPath, 'examples', 'catalog.json'), {
          allowMissingLeaf: true,
        })
      )
      .filter((catalogPath) => safeExistsSync(catalogPath) && safeLstat(catalogPath).isFile());

    expect(catalogs).toHaveLength(7);
    for (const catalogPath of catalogs) {
      const catalog = loadActuatorExampleCatalog(catalogPath);
      expect(catalog.actuator).toMatch(/^[a-z0-9][a-z0-9-]*$/u);
      expect(catalog.examples.length).toBeGreaterThan(0);
      expect(catalog.examples.every((example) => example.path.endsWith('.json'))).toBe(true);
    }
  });
});
