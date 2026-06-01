import { describe, expect, it } from 'vitest';
import { isLegacyMediaOp, loadLegacyMediaOpsCatalog } from './legacy-media-ops.js';

describe('legacy-media-ops', () => {
  it('resolves legacy media operations from knowledge', () => {
    const catalog = loadLegacyMediaOpsCatalog();

    expect(catalog.ops).toContain('document_report_design_from_brief');
    expect(isLegacyMediaOp('document_diagram_render_from_brief')).toBe(true);
  });
});
