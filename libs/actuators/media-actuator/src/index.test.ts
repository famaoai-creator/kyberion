import { beforeEach, describe, expect, it, vi } from 'vitest';
import { safeExistsSync, safeReadFile, safeRmSync } from '@agent/core';

const mocks = vi.hoisted(() => ({
  recognize: vi.fn(),
}));

vi.mock('tesseract.js', () => ({
  default: {
    recognize: mocks.recognize,
  },
  recognize: mocks.recognize,
}));

import { handleAction } from './index.js';

describe('media-actuator pdf to pptx bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders a drawio diagram file directly from a document brief', async () => {
    const outputPath = 'active/shared/tmp/media/document-brief-direct-render.drawio';
    if (safeExistsSync(outputPath)) {
      safeRmSync(outputPath, { force: true });
    }

    const result = await handleAction({
      action: 'pipeline',
      steps: [
        {
          type: 'apply',
          op: 'document_diagram_render_from_brief',
          params: {
            brief: {
              kind: 'document-brief',
              artifact_family: 'diagram',
              document_type: 'architecture-diagram',
              document_profile: 'solution-overview',
              render_target: 'drawio',
              locale: 'en-US',
              layout_template_id: 'kyberion-sovereign',
              payload: {
                title: 'Kyberion Overview',
                graph: {
                  nodes: [
                    { id: 'intent', type: 'generic', label: 'Intent' },
                    { id: 'work', type: 'generic', label: 'Work Loop' },
                  ],
                  edges: [
                    { id: 'edge-1', from: 'intent', to: 'work', label: 'resolves to' },
                  ],
                },
              },
            },
            path: outputPath,
          },
        },
      ],
    } as any);

    expect(result.status).toBe('succeeded');
    expect(safeExistsSync(outputPath)).toBe(true);
    const content = safeReadFile(outputPath, { encoding: 'utf8' }) as string;
    expect(content).toContain('Kyberion Overview');
    expect(content).toContain('value="intent"');
    expect(content).toContain('value="work"');
  });

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

  it('maps pdf clip regions to pptx image crop when an image is partially clipped', async () => {
    const result = await handleAction({
      action: 'pipeline',
      context: {
        last_pdf_design: {
          version: '4.0.0',
          generatedAt: '2026-03-25T00:00:00.000Z',
          source: { format: 'markdown', body: '', title: 'Clipped PDF' },
          content: {
            text: '',
            pages: [
              {
                pageNumber: 1,
                width: 200,
                height: 100,
                text: '',
                images: [
                  { path: '/tmp/mock-image.png', x: 20, y: 10, width: 120, height: 60 },
                ],
                elements: [
                  { type: 'clip', x: 50, y: 20, width: 60, height: 30, text: '', fontSize: 0, fontName: '' },
                ],
              },
            ],
          },
          metadata: { title: 'Clipped PDF', pageCount: 1 },
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
    const image = pageSlide.elements.find((element: any) => element.type === 'image');
    expect(image.crop).toEqual({
      left: 25000,
      top: 16667,
      right: 25000,
      bottom: 33333,
    });
    expect(image.pos).toEqual(
      expect.objectContaining({
        x: expect.any(Number),
        y: expect.any(Number),
        w: expect.any(Number),
        h: expect.any(Number),
      }),
    );
  });

  it('uses clip regions as pptx layout blocks and filters text outside the active clip', async () => {
    const result = await handleAction({
      action: 'pipeline',
      context: {
        last_pdf_design: {
          version: '4.0.0',
          generatedAt: '2026-03-25T00:00:00.000Z',
          source: { format: 'markdown', body: '', title: 'Clipped Layout PDF' },
          content: {
            text: '',
            pages: [
              {
                pageNumber: 1,
                width: 200,
                height: 100,
                text: '',
                elements: [
                  { type: 'clip', x: 20, y: 10, width: 100, height: 50, text: '', fontSize: 0, fontName: '' },
                  { type: 'rect', x: 18, y: 8, width: 104, height: 54, fillColor: '#DDEEFF', strokeColor: '#112233', opacity: 0.35 },
                  { type: 'border', x: 20, y: 10, width: 100, height: 1, strokeColor: '#445566', lineWidth: 2 },
                  { type: 'text', x: 30, y: 20, width: 60, height: 10, text: 'Inside block', fontSize: 12 },
                  { type: 'text', x: 150, y: 20, width: 35, height: 10, text: 'Outside block', fontSize: 12 },
                ],
              },
            ],
          },
          metadata: { title: 'Clipped Layout PDF', pageCount: 1 },
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
    const clipShape = pageSlide.elements.find((element: any) => element.type === 'shape' && element.id.startsWith('pdf-clip-'));
    expect(clipShape).toBeTruthy();
    expect(clipShape.style).toEqual(expect.objectContaining({
      fill: 'DDEEFF',
      line: '445566',
      lineWidth: 2,
      opacity: 35,
    }));
    expect(pageSlide.elements.some((element: any) => element.type === 'text' && element.text === 'Inside block')).toBe(true);
    expect(pageSlide.elements.some((element: any) => element.type === 'text' && element.text === 'Outside block')).toBe(false);
  });

  it('can enable full-page image overlay through pdf-to-pptx hints', async () => {
    const result = await handleAction({
      action: 'pipeline',
      context: {
        last_pdf_design: {
          version: '4.0.0',
          generatedAt: '2026-03-25T00:00:00.000Z',
          source: { format: 'markdown', body: '', title: 'Image Page PDF' },
          content: {
            text: '',
            pages: [
              {
                pageNumber: 1,
                width: 200,
                height: 100,
                text: '',
                images: [
                  { path: '/tmp/full-page.png', x: 0, y: 0, width: 200, height: 100 },
                  { path: '/tmp/inner.png', x: 50, y: 20, width: 40, height: 20 },
                ],
                elements: [
                  { type: 'clip', x: 10, y: 10, width: 180, height: 70, text: '', fontSize: 0, fontName: '' },
                  { type: 'text', x: 20, y: 18, width: 60, height: 12, text: 'Short', fontSize: 12 },
                  { type: 'heading', x: 20, y: 36, width: 120, height: 18, text: 'Large overlay title', fontSize: 20 },
                ],
                ocrLines: [
                  { id: 'ocr-1', type: 'heading', x: 18, y: 34, width: 120, height: 18, text: 'OCR Overlay Title', fontSize: 20, confidence: 92 },
                ],
              },
            ],
          },
          metadata: { title: 'Image Page PDF', pageCount: 1 },
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
            hints: {
              features: {
                fullPageImageOverlay: true,
                fullPageImageOcrOverlay: true,
              },
            },
          },
        },
      ],
    } as any);

    expect(result.status).toBe('succeeded');
    const pageSlide = result.context.last_pptx_design.slides.find((slide: any) => slide.id === 'pdf-page-1');
    expect(pageSlide.elements.some((element: any) => element.id === 'pdf-page-bg-1' && element.imagePath === '/tmp/full-page.png')).toBe(true);
    expect(pageSlide.elements.some((element: any) => element.type === 'image' && element.imagePath === '/tmp/inner.png')).toBe(true);
    expect(pageSlide.elements.some((element: any) => element.type === 'shape' && element.id.startsWith('pdf-clip-'))).toBe(false);
    expect(pageSlide.elements.some((element: any) => element.type === 'text' && element.text === 'OCR Overlay Title')).toBe(true);
    expect(pageSlide.elements.some((element: any) => element.type === 'text' && element.text === 'Short')).toBe(false);
  });

  it('runs OCR overlay for full-page image pages when extracted pdf text is mostly unreliable', async () => {
    mocks.recognize.mockResolvedValue({
      data: {
        confidence: 92,
        lines: [
          {
            text: 'OCR Restored Title',
            confidence: 92,
            bbox: { x0: 24, y0: 28, x1: 168, y1: 48 },
          },
        ],
      },
    });

    const unreliableElements = Array.from({ length: 12 }, (_, index) => ({
      type: index === 0 ? 'heading' : 'text',
      x: 20,
      y: 20 + index * 10,
      width: 80,
      height: 10,
      text: index % 2 === 0 ? 'G9GTGBGx' : 'GMG2GmG\u0081G>',
      fontSize: 12,
    }));

    const result = await handleAction({
      action: 'pipeline',
      context: {
        last_pdf_design: {
          version: '4.0.0',
          generatedAt: '2026-03-25T00:00:00.000Z',
          source: { format: 'markdown', body: '', title: 'Image OCR PDF' },
          content: {
            text: '',
            pages: [
              {
                pageNumber: 1,
                width: 200,
                height: 100,
                text: '',
                images: [
                  { path: '/tmp/full-page.png', x: 0, y: 0, width: 200, height: 100 },
                ],
                elements: unreliableElements,
              },
            ],
          },
          metadata: { title: 'Image OCR PDF', pageCount: 1 },
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
            hints: {
              features: {
                fullPageImageOverlay: true,
                fullPageImageOcrOverlay: true,
              },
              ocr: {
                language: 'jpn',
              },
            },
          },
        },
      ],
    } as any);

    expect(result.status).toBe('succeeded');
    expect(mocks.recognize).toHaveBeenCalledWith('/tmp/full-page.png', 'jpn');
    const pageSlide = result.context.last_pptx_design.slides.find((slide: any) => slide.id === 'pdf-page-1');
    expect(pageSlide.elements.some((element: any) => element.type === 'text' && element.text === 'OCR Restored Title')).toBe(true);
    expect(pageSlide.elements.some((element: any) => element.type === 'text' && element.text === 'G9GTGBGx')).toBe(false);
  });

  it('falls back to OCR text blocks when tesseract returns text without line boxes', async () => {
    mocks.recognize.mockResolvedValue({
      data: {
        confidence: 88,
        text: '最終報告書\nクロスカンパニーメンタリング',
        lines: [],
      },
    });

    const result = await handleAction({
      action: 'pipeline',
      context: {
        last_pdf_design: {
          version: '4.0.0',
          generatedAt: '2026-03-25T00:00:00.000Z',
          source: { format: 'markdown', body: '', title: 'Image OCR Text Fallback PDF' },
          content: {
            text: '',
            pages: [
              {
                pageNumber: 1,
                width: 200,
                height: 100,
                text: '',
                images: [
                  { path: '/tmp/full-page.png', x: 0, y: 0, width: 200, height: 100 },
                ],
                elements: [],
              },
            ],
          },
          metadata: { title: 'Image OCR Text Fallback PDF', pageCount: 1 },
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
            hints: {
              features: {
                fullPageImageOverlay: true,
                fullPageImageOcrOverlay: true,
              },
              ocr: {
                language: 'jpn',
              },
            },
          },
        },
      ],
    } as any);

    expect(result.status).toBe('succeeded');
    const pageSlide = result.context.last_pptx_design.slides.find((slide: any) => slide.id === 'pdf-page-1');
    expect(pageSlide.elements.some((element: any) => element.type === 'text' && element.text === '最終報告書')).toBe(true);
    expect(pageSlide.elements.some((element: any) => element.type === 'text' && element.text === 'クロスカンパニーメンタリング')).toBe(true);
  });

  it('bridges pdf design into xlsx design with merge and style hints', async () => {
    const result = await handleAction({
      action: 'pipeline',
      context: {
        last_pdf_design: {
          version: '4.0.0',
          generatedAt: '2026-03-25T00:00:00.000Z',
          source: { format: 'markdown', body: '', title: 'Seat Chart PDF' },
          content: {
            text: '',
            pages: [
              {
                pageNumber: 1,
                width: 120,
                height: 60,
                text: '',
                elements: [
                  { type: 'rect', x: 0, y: 0, width: 60, height: 20, fillColor: '#DDEEFF' },
                  { type: 'rect', x: 60, y: 0, width: 30, height: 20, fillColor: '#FFFFFF' },
                  { type: 'rect', x: 90, y: 0, width: 30, height: 20, fillColor: '#FFFFFF' },
                  { type: 'border', x: 0, y: 0, width: 120, height: 1 },
                  { type: 'border', x: 0, y: 20, width: 120, height: 1 },
                  { type: 'border', x: 0, y: 40, width: 120, height: 1 },
                  { type: 'border', x: 0, y: 0, width: 1, height: 40 },
                  { type: 'border', x: 60, y: 0, width: 1, height: 40 },
                  { type: 'border', x: 90, y: 0, width: 1, height: 40 },
                  { type: 'border', x: 120, y: 0, width: 1, height: 40 },
                  { type: 'text', x: 8, y: 8, text: 'Team A', fontSize: 12, color: '#1F2937' },
                  { type: 'text', x: 68, y: 8, text: 'Desk 1', fontSize: 10, color: '#111827' },
                  { type: 'text', x: 98, y: 8, text: 'Desk 2', fontSize: 10, color: '#111827' },
                ],
              },
            ],
          },
          metadata: { title: 'Seat Chart PDF', pageCount: 1 },
        },
      },
      steps: [
        {
          type: 'transform',
          op: 'pdf_to_xlsx_design',
          params: {
            from: 'last_pdf_design',
            export_as: 'last_xlsx_design',
          },
        },
      ],
    } as any);

    expect(result.status).toBe('succeeded');
    const sheet = result.context.last_xlsx_design.sheets[0];
    expect(sheet.mergeCells.length).toBeGreaterThan(0);
    expect(sheet.rows[0].cells.find((cell: any) => cell.ref === 'A1')).toEqual(
      expect.objectContaining({ value: 'Team A' }),
    );
    expect(result.context.last_xlsx_design.styles.cellXfs.length).toBeGreaterThan(1);
  });
});
