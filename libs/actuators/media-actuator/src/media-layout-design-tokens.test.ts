import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';
import { resolveSemanticRenderTokens } from './media-layout-design-tokens.js';

describe('media semantic render token boundary', () => {
  it('validates the merged token envelope through the governed catalog boundary', () => {
    const source = String(
      safeReadFile(
        pathResolver.rootResolve('libs/actuators/media-actuator/src/media-layout-design-tokens.ts'),
        { encoding: 'utf8' }
      )
    );

    expect(source).toContain("id: 'semantic-render-tokens'");
    expect(source).toContain('knowledge/product/schemas/semantic-render-tokens.schema.json');
    expect(source).toMatch(/\.validate\(\s*catalog,/);

    expect(resolveSemanticRenderTokens(pathResolver.rootDir(), 'hero').pptx).toEqual(
      expect.objectContaining({ title_align: 'left' })
    );
  });
});
