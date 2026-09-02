import { afterEach, describe, expect, it } from 'vitest';

import { pathResolver } from '@agent/core/path-resolver';
import {
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeSymlinkSync,
  safeWriteFile,
} from '@agent/core/secure-io';

import {
  loadJsonValue,
  loadDesignPattern,
  loadMediaDesignSystemsCatalog,
  readJsonFilesRecursively,
} from './media-catalog-loaders.js';

const rootDir = pathResolver.sharedTmp('media-catalog-loaders-test');

afterEach(() => {
  safeRmSync(rootDir, { recursive: true, force: true });
});

describe('media catalog loaders', () => {
  it('rejects a symlink from the standalone JSON loader', () => {
    const target = `${rootDir}/target.json`;
    const link = `${rootDir}/link.json`;
    safeMkdir(rootDir, { recursive: true });
    safeWriteFile(target, JSON.stringify({ source: 'target' }));
    safeSymlinkSync(target, link);

    expect(() => loadJsonValue(link)).toThrow('[RESOURCE_PATH_SYMLINK]');
  });

  it('does not import symlinked JSON during recursive catalog discovery', () => {
    const target = `${rootDir}/target.json`;
    const link = `${rootDir}/link.json`;
    safeMkdir(rootDir, { recursive: true });
    safeWriteFile(target, JSON.stringify({ source: 'target' }));
    safeSymlinkSync(target, link);

    expect(readJsonFilesRecursively(rootDir)).toEqual([{ source: 'target' }]);
  });

  it('validates the merged media design systems envelope through the catalog boundary', () => {
    const source = String(
      safeReadFile(
        pathResolver.rootResolve('libs/actuators/media-actuator/src/media-catalog-loaders.ts'),
        { encoding: 'utf8' }
      )
    );

    expect(source).toContain("id: 'media-design-systems'");
    expect(source).toContain(
      "schema: path.resolve(rootDir, 'knowledge/product/schemas/media-design-systems.schema.json')"
    );
    expect(source).toContain('return catalog.validate(merged, directoryPath);');

    const catalog = loadMediaDesignSystemsCatalog(pathResolver.rootDir());
    expect(catalog.default_system).toBe('executive-standard');
    expect(catalog.systems['executive-standard']).toBeDefined();
  });

  it('validates a design pattern through its dedicated schema boundary', () => {
    const source = String(
      safeReadFile(
        pathResolver.rootResolve('libs/actuators/media-actuator/src/media-catalog-loaders.ts'),
        { encoding: 'utf8' }
      )
    );

    expect(source).toContain("id: 'design-pattern'");
    expect(source).toContain('knowledge/product/schemas/design-pattern.schema.json');

    const patternPath = `${rootDir}/pattern.json`;
    safeMkdir(rootDir, { recursive: true });
    safeWriteFile(
      patternPath,
      JSON.stringify({
        pattern_id: 'test-pattern',
        category: 'strategic',
        target_audience: 'operators',
        layout_strategy: {
          visual_weight: 'balanced',
          structure: ['summary'],
        },
      })
    );

    expect(loadDesignPattern(pathResolver.rootDir(), patternPath)).toEqual(
      expect.objectContaining({ pattern_id: 'test-pattern' })
    );
  });
});
