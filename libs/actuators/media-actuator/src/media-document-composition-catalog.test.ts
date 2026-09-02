import { describe, expect, it } from 'vitest';

import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

import { loadDocumentCompositionCatalog } from './media-design-protocol.js';

describe('media document composition catalog boundary', () => {
  it('validates the merged preset and artifact profile envelope', () => {
    const source = String(
      safeReadFile(
        pathResolver.rootResolve('libs/actuators/media-actuator/src/media-design-protocol.ts'),
        { encoding: 'utf8' }
      )
    );

    expect(source).toContain("id: 'document-composition-presets'");
    expect(source).toContain('knowledge/product/schemas/document-composition-presets.schema.json');
    expect(source).toContain('return catalog.validate(');

    const catalog = loadDocumentCompositionCatalog(pathResolver.rootDir());
    expect(catalog.defaults).toBeDefined();
    expect(catalog.profiles).toBeDefined();
    expect(Object.keys(catalog.profiles).length).toBeGreaterThan(0);
  });
});
