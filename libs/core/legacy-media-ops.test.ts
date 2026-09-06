import { describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeReadFile } from './secure-io.js';
import { isLegacyMediaOp, loadLegacyMediaOpsCatalog } from './legacy-media-ops.js';

describe('legacy-media-ops', () => {
  it('uses the canonical catalog without a duplicated fallback definition', () => {
    const source = safeReadFile(pathResolver.rootResolve('libs/core/legacy-media-ops.ts'), {
      encoding: 'utf8',
    }) as string;
    expect(source).not.toContain('FALLBACK_CATALOG');
  });

  it('resolves legacy media operations from knowledge', () => {
    const catalog = loadLegacyMediaOpsCatalog();

    expect(catalog.ops).toContain('document_report_design_from_brief');
    expect(isLegacyMediaOp('document_diagram_render_from_brief')).toBe(true);
  });
});
