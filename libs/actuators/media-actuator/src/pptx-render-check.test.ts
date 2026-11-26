/**
 * Text fit in the media pipeline: pptx_layout_preflight / pptx_render measure
 * every text box (text_fit gate) and pptx_render_check compares the
 * LibreOffice render with the authored boxes.
 *
 * Regression: a hand-authored protocol carries no builder layoutDiagnostics,
 * so the old gate passed it untouched — labels wrapped in a chevron and a
 * body box overflowed in the rendered deck while preflight said "pass".
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeMkdir, safeRmSync } from '@agent/core/secure-io';
import { resolveSofficeBinary } from '@agent/core/visual-raster';
import type { PptxDesignProtocol, PptxElement } from '@agent/core/contracts/pptx-protocol';
import type {
  PptxRenderTextCheckResult,
  PptxTextFitReport,
} from '@agent/shared-media/native-pptx-engine/protocol-text-fit';
import { handleAction } from './index.js';
import type { MediaAction } from './media-pipeline-helpers.js';
import { summarizeMediaPptxLayout } from './media-document-pipeline-helpers.js';

const style = (fontSize: number, extra: Record<string, unknown> = {}) => ({
  fontFamily: 'BIZ UDPGothic',
  fontSize,
  margin: [0.03, 0.05, 0.03, 0.05] as [number, number, number, number],
  lineSpacing: 100,
  ...extra,
});

/** A chevron label that wraps, a body box one line short, and a label that fits. */
function deck(): PptxDesignProtocol {
  const elements: PptxElement[] = [
    {
      type: 'shape',
      shapeType: 'chevron',
      name: 'step-label',
      pos: { x: 0.3, y: 1, w: 3, h: 0.42 },
      text: '②次の工程　自動処理で検証を実施する',
      style: style(11, { bold: true, align: 'center', valign: 'middle', fill: 'DCE6F2' }),
    },
    {
      type: 'text',
      name: 'step-body',
      pos: { x: 0.3, y: 1.6, w: 2.97, h: 0.62 },
      text: '画面の操作を記録して手順書を作成\n担当者が確認した結果を次の工程の入力として使う\n例外の時だけ担当者へ通知',
      autofit: 'none',
      style: style(9.5),
    },
    {
      type: 'shape',
      shapeType: 'roundRect',
      name: 'fits',
      pos: { x: 3.5, y: 1.6, w: 1.6, h: 0.36 },
      text: '検証環境の準備',
      style: style(10.5, { bold: true, align: 'center', valign: 'middle', fill: 'FFFFFF' }),
    },
  ];
  return {
    version: '3.0.0',
    generatedAt: '2026-11-26T00:00:00.000Z',
    canvas: { w: 10, h: 7.5 },
    theme: {},
    master: { elements: [] },
    slides: [{ id: 'flow', elements }],
  };
}

interface Outcome {
  status: string;
  context: Record<string, unknown>;
}

const run = async (action: unknown): Promise<Outcome> =>
  (await handleAction(action as MediaAction)) as unknown as Outcome;

const preflight = (params: Record<string, unknown>) =>
  run({
    action: 'pipeline',
    context: { deck: deck() },
    steps: [
      { type: 'transform', op: 'pptx_layout_preflight', params: { from: 'deck', ...params } },
    ],
  });

describe('text fit in pptx_layout_preflight / pptx_render', () => {
  it('the builder-only diagnostics pass a hand-authored protocol (the missed detection)', () => {
    expect(summarizeMediaPptxLayout(deck()).status).toBe('pass');
  });

  it('reports overflow and unexpected wraps by default without failing', async () => {
    const result = await preflight({});
    expect(result.status).toBe('succeeded');
    const textFit = (result.context.media_layout_diagnostics as { textFit: PptxTextFitReport })
      .textFit;
    expect(textFit).toMatchObject({ status: 'overflow', overflowCount: 1 });
    const kinds = textFit.issues.map((i) => `${i.elementName}:${i.kind}`);
    expect(kinds).toContain('step-label:unexpected_wrap');
    expect(kinds).toContain('step-body:overflow');
    expect(kinds.some((k) => k.startsWith('fits:'))).toBe(false);
  });

  it('text_fit: error fails the step on overflow; allow_layout_overflow keeps review-only output', async () => {
    const failed = await preflight({ text_fit: 'error' });
    expect(failed.status).toBe('failed');
    expect(JSON.stringify(failed)).toContain('[MEDIA_TEXT_FIT]');
    expect(JSON.stringify(failed)).toContain('slide 1 element 1 overflow');

    const allowed = await preflight({ text_fit: 'error', allow_layout_overflow: true });
    expect(allowed.status).toBe('succeeded');
  });

  it('rejects an unknown gate level instead of guessing', async () => {
    const result = await preflight({ text_fit: 'strict' });
    expect(result.status).toBe('failed');
    expect(JSON.stringify(result)).toContain("text_fit 'strict' is not supported");
  });

  it('pptx_render refuses to write when text_fit: error finds an overflow', async () => {
    const out = pathResolver.sharedTmp(`pptx-text-fit-${process.pid}/blocked.pptx`);
    const result = await run({
      action: 'pipeline',
      context: { last_pptx_design: deck() },
      steps: [{ type: 'apply', op: 'pptx_render', params: { path: out, text_fit: 'error' } }],
    });
    expect(result.status).toBe('failed');
    expect(safeExistsSync(out)).toBe(false);
  });
});

describe('media:pptx_render_check', () => {
  const dir = pathResolver.sharedTmp(`pptx-render-check-${process.pid}`);
  const out = `${dir}/deck.pptx`;
  const hasSoffice = Boolean(resolveSofficeBinary({ refresh: true }));

  beforeAll(async () => {
    safeMkdir(dir, { recursive: true });
    const rendered = await run({
      action: 'pipeline',
      context: { last_pptx_design: deck() },
      steps: [{ type: 'apply', op: 'pptx_render', params: { path: out } }],
    });
    expect(rendered.status).toBe('succeeded');
  });
  afterAll(() => safeRmSync(dir, { recursive: true, force: true }));

  const check = (params: Record<string, unknown>, context: Record<string, unknown> = {}) =>
    run({
      action: 'pipeline',
      context: { last_pptx_design: deck(), ...context },
      steps: [{ type: 'capture', op: 'pptx_render_check', params: { path: out, ...params } }],
    });

  it('requires the authored protocol as the reference', async () => {
    const result = await check({ design_from: 'missing_design' });
    expect(result.status).toBe('failed');
    expect(JSON.stringify(result)).toContain('no PptxDesignProtocol at ctx.missing_design');
  });

  it.skipIf(!hasSoffice)(
    'finds the wrap and the overflow in the LibreOffice render, with slide / element / excerpt',
    async () => {
      const result = await check({ fail_on: 'never' });
      expect(result.status).toBe('succeeded');
      const report = result.context.pptx_render_check as PptxRenderTextCheckResult & {
        rendered: boolean;
      };
      expect(report).toMatchObject({ rendered: true, status: 'overflow', unmatchedElements: 0 });
      const issues = report.issues.map(
        (i) => `${i.slideIndex}:${i.elementIndex}:${i.kind}:${i.source}`
      );
      expect(issues).toEqual(
        expect.arrayContaining(['1:0:unexpected_wrap:render', '1:1:overflow:render'])
      );
      expect(report.issues.some((i) => i.elementIndex === 2)).toBe(false);
      expect(report.boxes.map((b) => [b.predictedLines, b.renderedLines])).toEqual([
        [2, 2],
        [4, 4],
        [1, 1],
      ]);
      expect(report.issues[0].excerpt).toContain('次の工程');

      const gated = await check({});
      expect(gated.status).toBe('failed');
      expect(JSON.stringify(gated)).toContain('pptx_render_check');
    },
    120_000
  );
});
