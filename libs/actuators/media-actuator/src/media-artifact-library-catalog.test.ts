import { describe, expect, it } from 'vitest';

import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

import { loadArtifactLibraryCatalog } from './media-design-protocol.js';

describe('media artifact library catalog', () => {
  it('loads merged profile packs through a dedicated validated catalog boundary', () => {
    const source = String(
      safeReadFile(
        pathResolver.rootResolve('libs/actuators/media-actuator/src/media-design-protocol.ts'),
        { encoding: 'utf8' }
      )
    );

    expect(source).toContain("id: 'artifact-library'");
    expect(source).toContain('artifact-library.schema.json');
    const loaderSource = source.slice(
      source.indexOf('function loadArtifactLibraryCatalog'),
      source.indexOf('function loadDocumentCompositionCatalog')
    );
    expect(loaderSource).not.toContain('fallbackOnInvalid: true');
    expect(source).toContain('return catalog.validate(merged, dirPath);');

    const catalog = loadArtifactLibraryCatalog(pathResolver.rootDir());
    expect(Object.keys(catalog.profiles).length).toBeGreaterThan(0);
    expect(catalog.profiles['project-charter']).toEqual(
      expect.objectContaining({
        artifact_family: 'presentation',
        document_type: 'charter',
        sections: expect.arrayContaining([
          expect.objectContaining({
            section_id: expect.any(String),
            layout_key: expect.any(String),
          }),
        ]),
      })
    );
  });
});
