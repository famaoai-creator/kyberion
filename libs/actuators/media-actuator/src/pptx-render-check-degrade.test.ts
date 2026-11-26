/**
 * pptx_render_check on a host without LibreOffice: the conversion is reported
 * as unavailable (with the pre-render model findings), never as a pass and
 * never as a crash.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@agent/core/visual-raster', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/visual-raster')>()),
  convertDocumentToPdf: () => ({
    available: false,
    unavailable_reason: 'cannot convert deck.pptx to PDF on this host: missing soffice.',
  }),
}));

import { pathResolver } from '@agent/core/path-resolver';
import { handleAction } from './index.js';
import type { MediaAction } from './media-pipeline-helpers.js';

describe('media:pptx_render_check without LibreOffice', () => {
  it('degrades to status unavailable and carries the model findings', async () => {
    const result = (await handleAction({
      action: 'pipeline',
      context: {
        last_pptx_design: {
          version: '3.0.0',
          generatedAt: '2026-11-26T00:00:00.000Z',
          canvas: { w: 10, h: 7.5 },
          theme: {},
          master: { elements: [] },
          slides: [
            {
              id: 's1',
              elements: [
                {
                  type: 'text',
                  pos: { x: 0, y: 0, w: 1.5, h: 0.25 },
                  text: '画面の操作を記録して手順書を作成し、確認した結果を次の工程の入力にする',
                  style: { fontSize: 10 },
                },
              ],
            },
          ],
        },
      },
      steps: [
        {
          type: 'capture',
          op: 'pptx_render_check',
          params: { path: pathResolver.sharedTmp('pptx-render-check-degrade/deck.pptx') },
        },
      ],
    } as unknown as MediaAction)) as unknown as {
      status: string;
      context: { pptx_render_check: { model: { overflowCount: number } } };
    };
    expect(result.status).toBe('succeeded');
    expect(result.context.pptx_render_check).toMatchObject({
      status: 'unavailable',
      rendered: false,
      unavailable_reason: expect.stringContaining('missing soffice'),
    });
    expect(result.context.pptx_render_check.model.overflowCount).toBe(1);
  });
});
