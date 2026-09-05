import { describe, expect, it } from 'vitest';

import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

import { loadImportedDesignMdIndex } from './media-design-protocol.js';

describe('imported DESIGN.md catalog', () => {
  it('loads the index through a dedicated validated catalog boundary', () => {
    const source = String(
      safeReadFile(
        pathResolver.rootResolve('libs/actuators/media-actuator/src/media-design-protocol.ts'),
        { encoding: 'utf8' }
      )
    );

    expect(source).toContain("id: 'imported-design-md-index'");
    expect(source).toContain('imported-design-md-index.schema.json');
    expect(source).toContain('return catalog.validate(merged, directoryPath);');
    const loaderSource = source.slice(
      source.indexOf('function loadImportedDesignMdIndex'),
      source.indexOf('function normalizeDesignLookupKey')
    );
    expect(loaderSource).not.toContain('fallbackOnInvalid: true');

    const catalog = loadImportedDesignMdIndex(pathResolver.rootDir());
    expect(catalog.count).toBe(catalog.systems.length);
    expect(catalog.systems.length).toBeGreaterThan(0);
    expect(catalog.systems[0]).toEqual(
      expect.objectContaining({
        design_system_id: expect.any(String),
        source_path: expect.any(String),
        keywords: expect.any(Array),
      })
    );
  });
});
