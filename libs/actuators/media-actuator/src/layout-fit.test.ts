/**
 * MP-03: slide bodies are fitted to their boxes before rendering.
 *
 * Covers the regression that made decks look broken: body text was emitted at
 * a constant size regardless of how much of it arrived, so long Japanese
 * bodies ran past their frame. The compiler now measures and shrinks toward
 * the brand ramp floor, and reports boxes that overflow even at the floor.
 */
import { describe, expect, it } from 'vitest';
import { handleAction } from './index.js';

const LONG_SENTENCE =
  '本施策では既存の業務プロセスを段階的に自動化し、担当者の確認負荷を下げながら品質を維持します。' +
  '加えて監査証跡を自動で残すため、運用開始後の検証コストも継続的に低減できます。' +
  'さらに既存システムとの接続は段階的に行い、移行期間中も業務を止めない設計とします。';

function brief(coreMessage: string, sectionCount = 1) {
  return {
    kind: 'proposal-brief',
    document_profile: 'executive-proposal',
    render_target: 'pptx',
    locale: 'ja-JP',
    title: 'レイアウトフィット検証',
    objective: 'テキスト量に応じた自動フィットを検証する。',
    story: { core_message: coreMessage, closing_cta: '方針を承認する。' },
    sections: Array.from({ length: sectionCount }, (_, i) => ({
      title: `検証セクション${i + 1}`,
      objective: `${i + 1}件目の長文本文フィット確認。${LONG_SENTENCE}`,
      body: [LONG_SENTENCE],
    })),
  };
}

async function compileProtocol(input: Record<string, unknown>): Promise<any> {
  const result = await handleAction({
    action: 'pipeline',
    context: { last_json: input },
    steps: [
      {
        type: 'transform',
        op: 'brief_to_design_protocol',
        params: { from: 'last_json', export_as: 'pptx_design' },
      },
    ],
  } as any);
  expect(result.status).toBe('succeeded');
  return result.context.pptx_design;
}

/** Font size of the first body element whose text starts the table of contents. */
function contentsBodySize(protocol: any): number {
  for (const slide of protocol.slides) {
    for (const el of slide.elements || []) {
      if (typeof el.text === 'string' && el.text.startsWith('1. ') && el.style?.fontSize) {
        return el.style.fontSize;
      }
    }
  }
  throw new Error('no contents body element found');
}

describe('MP-03 slide layout fit', () => {
  it('shrinks a long Japanese body instead of overflowing its box', async () => {
    const short = await compileProtocol(brief('本文量に応じて調整される。'));
    const long = await compileProtocol(brief(LONG_SENTENCE.repeat(3)));

    expect(contentsBodySize(long)).toBeLessThan(contentsBodySize(short));
    // Never below the brand ramp floor — illegible text is the worse failure.
    expect(contentsBodySize(long)).toBeGreaterThanOrEqual(10);
  });

  it('keeps the designed size when the text already fits', async () => {
    const protocol = await compileProtocol(brief('要点は3つあります。'));
    expect(contentsBodySize(protocol)).toBeGreaterThanOrEqual(13);
  });

  it('fits hero and standard titles and exposes layout diagnostics', async () => {
    const input = brief('短い要点。');
    input.title = '自動化された業務プロセスの設計と監査証跡を一体化するための長い提案タイトル';
    const protocol = await compileProtocol(input);
    const titleSizes = protocol.slides
      .flatMap((slide: any) => slide.elements || [])
      .filter((el: any) => el.placeholderType === 'title')
      .map((el: any) => el.style?.fontSize)
      .filter((size: unknown): size is number => typeof size === 'number');

    expect(titleSizes.length).toBeGreaterThan(0);
    expect(Math.min(...titleSizes)).toBeLessThan(32);
    expect(protocol.metadata.layoutDiagnostics).toMatchObject({
      slideCount: protocol.slides.length,
      shrinkCount: expect.any(Number),
      overflowCount: expect.any(Number),
    });
  });

  it('never emits body text below the ramp floor, however heavy the deck', async () => {
    const protocol = await compileProtocol(brief(LONG_SENTENCE.repeat(2), 24));
    const bodySizes = protocol.slides.flatMap((slide: any) =>
      (slide.elements || [])
        .filter((el: any) => typeof el.text === 'string' && el.text.length > 40)
        .map((el: any) => el.style?.fontSize)
        .filter((size: unknown): size is number => typeof size === 'number')
    );
    expect(bodySizes.length).toBeGreaterThan(0);
    for (const size of bodySizes) expect(size).toBeGreaterThanOrEqual(10);
    // The heavy deck must actually exercise the ladder, not just pass by
    // staying at the designed size everywhere.
    expect(Math.min(...bodySizes)).toBeLessThan(13);
  });

  it('produces identical font sizes for identical briefs (determinism)', async () => {
    const input = brief(LONG_SENTENCE.repeat(3), 4);
    const first = await compileProtocol(input);
    const second = await compileProtocol(input);
    const sizes = (protocol: any) =>
      protocol.slides.flatMap((slide: any) =>
        (slide.elements || []).map((el: any) => el.style?.fontSize ?? null)
      );
    expect(sizes(first)).toEqual(sizes(second));
  });

  it('blocks render preflight when a box still overflows at the floor', async () => {
    const result = await handleAction({
      action: 'pipeline',
      context: { last_json: brief(LONG_SENTENCE.repeat(10), 24) },
      steps: [
        {
          type: 'transform',
          op: 'brief_to_design_protocol',
          params: { from: 'last_json', export_as: 'last_pptx_design' },
        },
        {
          type: 'transform',
          op: 'pptx_layout_preflight',
          params: { from: 'last_pptx_design' },
        },
      ],
    } as any);

    expect(result.status).toBe('failed');
    expect(result.results?.find((entry: any) => entry.status === 'failed')?.error).toMatch(
      /\[MEDIA_LAYOUT\].*overflow/i
    );
  });
});
