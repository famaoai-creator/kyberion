import { describe, expect, it } from 'vitest';
import { handleAction } from './index.js';
import type { MediaAction } from './media-pipeline-helpers.js';
import type { PptxDesignProtocol } from '@agent/core/media/media-contracts';

describe('media:deck_from_geometry', () => {
  /** ブラウザ計測の戻り値を模したもの（browser:evaluate が返す幾何スキーマ）。 */
  const GEOMETRY = {
    viewW: 1000,
    pageH: 900,
    cuts: [40, 500],
    boxes: [
      { x: 20, y: 40, w: 960, h: 60, fill: 'rgb(31, 58, 95)', radius: 8, borderLeft: null },
      {
        x: 20,
        y: 520,
        w: 960,
        h: 40,
        fill: null,
        radius: 0,
        borderLeft: { w: 4, color: 'rgb(179, 18, 59)' },
      },
    ],
    texts: [
      {
        x: 20,
        y: 40,
        w: 200,
        h: 30,
        pad: [1, 7, 1, 7],
        inkW: 180,
        text: '+105%',
        fontSize: 13,
        bold: true,
        color: 'rgb(47, 125, 91)',
        align: 'center',
        lines: 1,
        tag: 'span',
        cls: 'chip',
      },
      {
        x: 20,
        y: 520,
        w: 960,
        h: 40,
        pad: [8, 12, 8, 12],
        inkW: 900,
        text: '章2の本文',
        fontSize: 16,
        bold: false,
        color: 'rgb(26, 31, 41)',
        align: 'left',
        lines: 1,
        tag: 'div',
        cls: 'callout',
      },
    ],
  };

  it('transcribes measured geometry into a pptx protocol (4:3)', async () => {
    const result = await handleAction({
      action: 'pipeline',
      context: { measured: GEOMETRY },
      steps: [
        {
          type: 'transform',
          op: 'deck_from_geometry',
          params: { from: 'measured', aspect: '4:3', export_as: 'compiled' },
        },
      ],
    } as MediaAction);

    expect(result.status).toBe('succeeded');
    const proto = result.context.compiled as PptxDesignProtocol;
    expect(proto.canvas).toEqual({ w: 10, h: 7.5 });
    // cuts が2つあるので章は2枚に分かれる
    expect(proto.slides.length).toBe(2);
    expect(result.context.last_pptx_design).toBe(proto);
    expect(result.context.last_design_protocol_kind).toBe('pptx');
  });

  it('maps HTML padding onto the pptx text inset and never narrows below ink width', async () => {
    const result = await handleAction({
      action: 'pipeline',
      context: { measured: GEOMETRY },
      steps: [{ type: 'transform', op: 'deck_from_geometry', params: { from: 'measured' } }],
    } as MediaAction);

    const proto = result.context.last_pptx_design as PptxDesignProtocol;
    const chip = proto.slides[0].elements.find((el: any) => el.text === '+105%') as any;
    expect(chip).toBeTruthy();
    // padding[right]=7px, [left]=7px を 100px/in で 0.07in のインセットへ写す
    expect(chip.style.margin).toEqual([0.01, 0.07, 0.01, 0.07]);
    // inkW(180) + pad(14) + 2 = 196px > w(200px) ではないので実測幅が保たれる
    expect(chip.pos.w).toBeCloseTo(2.0, 2);
  });

  it('reports a browser-measured layout diagnostic so preflight does not re-estimate', async () => {
    const result = await handleAction({
      action: 'pipeline',
      context: { measured: GEOMETRY },
      steps: [
        { type: 'transform', op: 'deck_from_geometry', params: { from: 'measured' } },
        { type: 'transform', op: 'pptx_layout_preflight', params: { from: 'last_pptx_design' } },
      ],
    } as MediaAction);

    expect(result.status).toBe('succeeded');
    const diag = result.context.media_layout_diagnostics as any;
    expect(diag.measurementModel).toBe('browser-measured');
    expect(diag.overflowCount).toBe(0);
  });

  it('rejects geometry that is missing boxes/texts', async () => {
    const result = await handleAction({
      action: 'pipeline',
      context: { measured: { viewW: 1000 } },
      steps: [{ type: 'transform', op: 'deck_from_geometry', params: { from: 'measured' } }],
    } as MediaAction);

    expect(result.status).toBe('failed');
  });
});

describe('media:deck_measurement_script', () => {
  it('emits an in-page script that pins the measurement font to the output font', async () => {
    const result = await handleAction({
      action: 'pipeline',
      steps: [
        {
          type: 'transform',
          op: 'deck_measurement_script',
          params: { aspect: '4:3', export_as: 'script' },
        },
      ],
    } as MediaAction);

    expect(result.status).toBe('succeeded');
    const script = String(result.context.script);
    // 計測フォントは出力と同一（別フォントで測ると幅がずれてチップ内が割れる）
    expect(script).toContain('BIZ UDPGothic');
    expect(script).toContain('getBoundingClientRect');
    expect(script).toContain('getClientRects');
    expect(script).toContain('paddingLeft');
  });
});
