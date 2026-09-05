import { describe, expect, it } from 'vitest';
import { parseConciergeOutcomePreviewResponse } from './outcome-preview-response';

describe('concierge outcome preview response boundary', () => {
  it('accepts bounded artifact previews', () => {
    expect(
      parseConciergeOutcomePreviewResponse({
        ok: true,
        preview: {
          entry_id: 'outcome-1',
          total: 2,
          shown: 1,
          files: [{ name: 'report.md', kind: 'markdown', content: '# Report' }],
        },
      })
    ).toEqual({
      entry_id: 'outcome-1',
      total: 2,
      shown: 1,
      files: [{ name: 'report.md', kind: 'markdown', content: '# Report' }],
    });
  });

  it('accepts name-only and image metadata previews', () => {
    expect(
      parseConciergeOutcomePreviewResponse({
        ok: true,
        preview: {
          entry_id: 'outcome-2',
          total: 2,
          shown: 2,
          files: [
            { name: 'missing.txt', kind: 'other', missing: true },
            { name: 'avatar.png', kind: 'image', data_uri: 'data:image/png;base64,AA==' },
          ],
        },
      })
    ).toBeDefined();
  });

  it('rejects invalid counts, artifacts, and dangerous keys', () => {
    expect(
      parseConciergeOutcomePreviewResponse({
        ok: true,
        preview: { entry_id: 'outcome-1', total: 1, shown: 2, files: [] },
      })
    ).toBeUndefined();
    expect(
      parseConciergeOutcomePreviewResponse({
        ok: true,
        preview: { entry_id: 'outcome-1', total: 1, shown: 1, files: [{ name: 'x', kind: 'pdf' }] },
      })
    ).toBeUndefined();
    const unsafe = JSON.parse(
      '{"ok":true,"preview":{"entry_id":"outcome-1","total":1,"shown":1,"files":[{"name":"x","kind":"other","constructor":{}}]}}'
    );
    expect(parseConciergeOutcomePreviewResponse(unsafe)).toBeUndefined();
  });
});
