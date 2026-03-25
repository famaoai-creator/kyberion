import { describe, expect, it } from 'vitest';

import { handleAction } from './index.js';

describe('media-actuator pdf to pptx bridge', () => {
  it('bridges pdf design into pptx design before render', async () => {
    const result = await handleAction({
      action: 'pipeline',
      context: {
        last_pdf_design: {
          version: '4.0.0',
          generatedAt: '2026-03-25T00:00:00.000Z',
          source: { format: 'markdown', body: '', title: 'Dummy PDF file' },
          content: {
            text: 'First line\nSecond line',
            pages: [
              { pageNumber: 1, width: 612, height: 792, text: 'Page one summary\nDetail A' },
            ],
          },
          metadata: { title: 'Dummy PDF file', pageCount: 1 },
        },
      },
      steps: [
        {
          type: 'transform',
          op: 'pdf_to_pptx_design',
          params: {
            from: 'last_pdf_design',
            export_as: 'last_pptx_design',
          },
        },
      ],
    } as any);

    expect(result.status).toBe('succeeded');
    expect(result.context.last_pptx_design).toEqual(
      expect.objectContaining({
        slides: expect.arrayContaining([
          expect.objectContaining({ id: 'pdf-title' }),
          expect.objectContaining({ id: 'pdf-page-1' }),
        ]),
      }),
    );
  });

  it('normalizes octal/pdf bullet text and groups positioned lines into readable slide elements', async () => {
    const result = await handleAction({
      action: 'pipeline',
      context: {
        last_pdf_design: {
          version: '4.0.0',
          generatedAt: '2026-03-25T00:00:00.000Z',
          source: { format: 'markdown', body: '', title: 'PDF Layout' },
          content: {
            text: '',
            pages: [
              {
                pageNumber: 1,
                width: 600,
                height: 800,
                text: '',
                elements: [
                  { type: 'text', x: 25, y: 40, width: 80, height: 12, text: 'G=G{GGG9G', fontSize: 10 },
                  { type: 'text', x: 40, y: 60, width: 120, height: 12, text: '', fontSize: 10 },
                  { type: 'text', x: 58, y: 60, width: 280, height: 12, text: 'p.4\\2267', fontSize: 10 },
                  { type: 'text', x: 58, y: 60, width: 280, height: 12, text: '実施概要', fontSize: 10 },
                ],
              },
            ],
          },
          metadata: { title: 'PDF Layout', pageCount: 1 },
          aesthetic: { elements: [] },
        },
      },
      steps: [
        {
          type: 'transform',
          op: 'pdf_to_pptx_design',
          params: {
            from: 'last_pdf_design',
            export_as: 'last_pptx_design',
          },
        },
      ],
    } as any);

    expect(result.status).toBe('succeeded');
    const pageSlide = result.context.last_pptx_design.slides.find((slide: any) => slide.id === 'pdf-page-1');
    expect(pageSlide.elements.some((element: any) => typeof element.text === 'string' && element.text.includes('• p.4–7 実施概要'))).toBe(true);
    expect(pageSlide.elements.some((element: any) => typeof element.text === 'string' && element.text.includes('G=G{GGG9G'))).toBe(false);
    expect(pageSlide.elements.filter((element: any) => typeof element.text === 'string' && element.text.includes('自由回答')).length).toBeLessThanOrEqual(1);
  });

  it('falls back to summary mode for grid-like pptx-exported pdf pages', async () => {
    const elements = [];
    for (let i = 0; i < 80; i++) {
      elements.push({
        type: 'text',
        x: (i % 20) * 22,
        y: 40 + Math.floor(i / 20) * 10,
        width: 18,
        height: 10,
        text: i % 3 === 0 ? 'G=G{GGG9G' : '✓',
      });
    }

    const result = await handleAction({
      action: 'pipeline',
      context: {
        last_pdf_design: {
          version: '4.0.0',
          generatedAt: '2026-03-25T00:00:00.000Z',
          source: { format: 'markdown', body: '', title: 'Grid PDF' },
          content: {
            text: 'Readable fallback text',
            pages: [
              {
                pageNumber: 1,
                width: 600,
                height: 800,
                text: [
                  'カテゴリ\t選択肢\t回答方法\t質問文',
                  'スキルインプット',
                  '1~6 +自由回答',
                  '本日のスキルインプットセッションの満足度はどの程度ですか',
                  '役立つ/特に役立たない\t1~2',
                  '本日のセッションで学んだ内容は今後のキャリアに活かせそうですか',
                ].join('\n'),
                elements,
              },
            ],
          },
          metadata: { title: 'Grid PDF', pageCount: 1 },
          aesthetic: { elements: [] },
        },
      },
      steps: [
        {
          type: 'transform',
          op: 'pdf_to_pptx_design',
          params: {
            from: 'last_pdf_design',
            export_as: 'last_pptx_design',
          },
        },
      ],
    } as any);

    const pageSlide = result.context.last_pptx_design.slides.find((slide: any) => slide.id === 'pdf-page-1');
    expect(pageSlide.elements[0].text).toBe('Page 1');
    expect(pageSlide.elements[1].text).toContain('本日のスキルインプットセッションの満足度はどの程度ですか');
    expect(pageSlide.elements[1].text).toContain('本日のセッションで学んだ内容は今後のキャリアに活かせそうですか');
  });
});
