/**
 * Protocol-level text fit: the pre-render model (checkPptxTextFit) and the
 * post-render comparison (compareRenderedTextRuns).
 *
 * The fixture reproduces the failure classes that used to pass the layout
 * gate — a label wrapping in a chevron / home plate, a body box one line too
 * short, a one-sentence 18pt headline, labels in a dashed rounded rectangle —
 * next to known-good twins that must stay unflagged. When LibreOffice is
 * installed, the fixture is also rendered and the measured layout must report
 * the same issues as the model.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeMkdir, safeReadFile, safeRmSync } from '@agent/core/secure-io';
import { convertDocumentToPdf, resolveSofficeBinary } from '@agent/core/visual-raster';
import { generateNativePptx } from '@agent/core/media/native-pptx-engine/engine';
import type { PptxDesignProtocol, PptxElement } from '@agent/core/contracts/pptx-protocol';
import {
  checkPptxTextFit,
  compareRenderedTextRuns,
  extractPdfTextRuns,
  latinMetricsClass,
  measureRendererWidthEm,
  pdfTextItemsToRuns,
  predictPptxTextBoxes,
  presetTextRectInsets,
  wrapParagraphForRenderer,
  type PptxTextFitIssue,
  type RenderedTextRun,
} from '../protocol-text-fit.js';
import { buildTextFitFixtureProtocol } from './text-fit-fixture.js';

function nameOf(protocol: PptxDesignProtocol, issue: PptxTextFitIssue): string {
  return protocol.slides[issue.slideIndex - 1]!.elements[issue.elementIndex]!.name ?? '';
}

function flagged(protocol: PptxDesignProtocol, issues: PptxTextFitIssue[]) {
  const byKind = (kind: PptxTextFitIssue['kind']) =>
    [...new Set(issues.filter((i) => i.kind === kind).map((i) => nameOf(protocol, i)))].sort();
  return { overflow: byKind('overflow'), wrap: byKind('unexpected_wrap') };
}

const EXPECTED = {
  overflow: ['overflow-body-3-lines'],
  wrap: [
    'overflow-body-3-lines',
    'wrap-chevron-label',
    'wrap-dashed-roundrect',
    'wrap-dashed-roundrect-mixed',
    'wrap-headline-18pt',
    'wrap-homeplate-label',
  ],
};

function slide(elements: PptxElement[]): PptxDesignProtocol {
  return {
    version: '3.0.0',
    generatedAt: '2026-11-26T00:00:00.000Z',
    canvas: { w: 10, h: 7.5 },
    theme: {},
    master: { elements: [] },
    slides: [{ id: 's1', elements }],
  };
}

describe('renderer width model', () => {
  it('sets full-width glyphs, full-width punctuation and spaces at 1em', () => {
    expect(measureRendererWidthEm('検証環境')).toBe(4);
    expect(measureRendererWidthEm('（参考）、。　＋＝「」')).toBe(11);
    expect(measureRendererWidthEm('①→■※')).toBe(4);
  });

  it('adds the renderer autospace at each CJK / Latin boundary', () => {
    const plain = measureRendererWidthEm('連携') + measureRendererWidthEm('API');
    expect(measureRendererWidthEm('API連携')).toBeCloseTo(plain + 0.25, 5);
    expect(measureRendererWidthEm('AがB')).toBeCloseTo(
      measureRendererWidthEm('A') + 1 + measureRendererWidthEm('B') + 0.5,
      5
    );
  });

  it('widens Latin for BIZ UD fonts and for bold, never CJK', () => {
    expect(latinMetricsClass('BIZ UDPゴシック')).toBe('bizUd');
    expect(latinMetricsClass('BIZ UDPGothic, sans-serif')).toBe('bizUd');
    expect(latinMetricsClass('Yu Gothic')).toBe('proportional');
    expect(measureRendererWidthEm('Review', false, 'BIZ UDPGothic')).toBeGreaterThan(
      measureRendererWidthEm('Review', false, 'Arial') * 1.15
    );
    expect(measureRendererWidthEm('Review', true)).toBeGreaterThan(
      measureRendererWidthEm('Review', false)
    );
    expect(measureRendererWidthEm('検証', true, 'BIZ UDPGothic')).toBe(2);
  });

  it('breaks Japanese anywhere but keeps kinsoku and whole Latin words', () => {
    // 10 chars in a 6.5em line: the 。 may not start line 2, so 、 is pulled down with 結.
    expect(wrapParagraphForRenderer('確認した結果、次へ。', 6.5)).toEqual([
      '確認した結',
      '果、次へ。',
    ]);
    expect(wrapParagraphForRenderer('いいいいい、', 5.5)).toEqual(['いいいい', 'い、']);
    expect(wrapParagraphForRenderer('Review the API design', 6)).toEqual([
      'Review the',
      'API design',
    ]);
    // Exactly-full lines wrap: LibreOffice rounds box geometry.
    expect(wrapParagraphForRenderer('検証環境', 4)).toHaveLength(2);
    expect(wrapParagraphForRenderer('検証環境', 4.1)).toHaveLength(1);
  });

  it('trims a long trailing whitespace run when wrapping', () => {
    expect(wrapParagraphForRenderer(`確認${'\t'.repeat(20_000)}`, 4)).toEqual(['確認']);
  });
});

describe('preset text rectangles', () => {
  it('narrows chevron, home plate, rounded rectangle and ellipse to their text area', () => {
    expect(presetTextRectInsets('chevron', 3, 0.42).insets).toEqual([0, 0.21, 0, 0.21]);
    expect(presetTextRectInsets('homePlate', 3, 0.42).insets).toEqual([0, 0.105, 0, 0]);
    const round = presetTextRectInsets('roundRect', 2, 0.4).insets[0];
    expect(round).toBeCloseTo(0.4 * 0.16667 * 0.29289, 4);
    const ellipse = presetTextRectInsets('ellipse', 2, 1).insets;
    expect(ellipse[1]).toBeCloseTo(1 - Math.SQRT1_2, 4);
    expect(presetTextRectInsets('rect', 2, 1)).toEqual({ insets: [0, 0, 0, 0], known: true });
    expect(presetTextRectInsets('star5', 2, 1).known).toBe(false);
  });

  it('honours cornerRadius the way the engine writes the adjust value', () => {
    const tight = presetTextRectInsets('roundRect', 2, 0.4, 0.5).insets[0];
    expect(tight).toBeCloseTo(0.4 * 0.5 * 0.29289, 4);
  });
});

describe('checkPptxTextFit (pre-render model)', () => {
  it('flags every observed failure class and none of the known-good twins', () => {
    const protocol = buildTextFitFixtureProtocol();
    const report = checkPptxTextFit(protocol);
    expect(flagged(protocol, report.issues)).toEqual(EXPECTED);
    expect(report.status).toBe('overflow');
    expect(report.issues.every((i) => !nameOf(protocol, i).startsWith('ok-'))).toBe(true);
    const overflow = report.issues.find((i) => i.kind === 'overflow')!;
    expect(overflow).toMatchObject({ severity: 'error', slideIndex: 1, source: 'model' });
    expect(overflow.excerpt).toContain('画面の操作を記録');
  });

  it('uses the default bodyPr insets when the element sets no margin', () => {
    const text = '検証環境の準備と動作確認'; // 12em at 10pt = 1.667in
    const withDefault = slide([
      {
        type: 'shape',
        shapeType: 'rect',
        pos: { x: 0, y: 0, w: 1.8, h: 0.5 },
        text,
        style: { fontSize: 10, align: 'center' },
      },
    ]);
    const noInsets = slide([
      {
        type: 'shape',
        shapeType: 'rect',
        pos: { x: 0, y: 0, w: 1.8, h: 0.5 },
        text,
        style: { fontSize: 10, align: 'center', margin: [0, 0, 0, 0] },
      },
    ]);
    expect(checkPptxTextFit(withDefault).unexpectedWrapCount).toBe(1);
    expect(checkPptxTextFit(noInsets).unexpectedWrapCount).toBe(0);
  });

  it('reads insets from raw bodyPr XML', () => {
    const el: PptxElement = {
      type: 'text',
      pos: { x: 0, y: 0, w: 1.8, h: 0.5 },
      text: '検証環境の準備と動作確認',
      style: { fontSize: 10, align: 'center' },
      bodyPrXml: '<a:bodyPr lIns="0" rIns="0" tIns="0" bIns="0"/>',
    };
    expect(checkPptxTextFit(slide([el])).issues).toEqual([]);
  });

  it('lets left-aligned body text wrap when the box has room for it', () => {
    const body = '本文は左揃えで、枠の高さに余裕があるため折り返しても問題ありません。';
    const roomy = slide([
      { type: 'text', pos: { x: 0, y: 0, w: 2, h: 1.2 }, text: body, style: { fontSize: 11 } },
    ]);
    expect(checkPptxTextFit(roomy).issues).toEqual([]);
    const tight = slide([
      { type: 'text', pos: { x: 0, y: 0, w: 2, h: 0.3 }, text: body, style: { fontSize: 11 } },
    ]);
    expect(flagged(tight, checkPptxTextFit(tight).issues)).toEqual({ overflow: [''], wrap: [''] });
  });

  it('measures each paragraph at its own run size', () => {
    const el: PptxElement = {
      type: 'text',
      pos: { x: 0, y: 0, w: 2, h: 0.45 },
      textRuns: [
        { text: '現在\n', options: { fontSize: 13 } },
        { text: '連携されていない基幹システム', options: { fontSize: 9.5 } },
      ],
      style: { margin: [0.02, 0.04, 0.02, 0.04] },
    };
    const [box] = predictPptxTextBoxes(slide([el])).boxes;
    expect(box!.paragraphSizesPt).toEqual([13, 9.5]);
    expect(box!.lineCount).toBe(2);
    expect(checkPptxTextFit(slide([el])).issues).toEqual([]);
  });

  it('skips what it cannot measure instead of guessing', () => {
    const protocol = slide([
      {
        type: 'text',
        pos: { x: 0, y: 0, w: 1, h: 0.3 },
        text: '長い文章がここに入ります長い文章',
        pXmlLst: ['<a:p/>'],
      },
      { type: 'text', pos: { x: 0, y: 1, w: 1, h: 0.3 }, text: '寸法の指定がない文字列' },
      {
        type: 'shape',
        shapeType: 'rect',
        pos: { x: 0, y: 2, w: 1, h: 0.3 },
        text: '回転した長い見出しの文字列',
        style: { fontSize: 12, rotate: 90 },
      },
    ]);
    const { boxes, skipped } = predictPptxTextBoxes(protocol);
    expect(boxes).toEqual([]);
    expect(skipped.map((s) => s.reason)).toEqual([
      'template paragraphs (pXmlLst) — font metrics come from the template',
      'no font size (inherited from template)',
      'rotated',
    ]);
  });

  it('trusts renderer autofit: normAutofit never overflows, spAutoFit grows the box', () => {
    const long = '画面の操作を記録して手順書を作成し、確認した結果を次の工程の入力にする';
    const base: PptxElement = {
      type: 'text',
      pos: { x: 0, y: 0, w: 1.5, h: 0.25 },
      text: long,
      style: { fontSize: 10 },
    };
    expect(checkPptxTextFit(slide([base])).overflowCount).toBe(1);
    expect(checkPptxTextFit(slide([{ ...base, autofit: 'normal' }])).issues).toEqual([]);
    expect(checkPptxTextFit(slide([{ ...base, autofit: 'shrink' }])).overflowCount).toBe(0);
  });

  it('fills missing sizes from the design-defaults cascade before measuring', () => {
    const protocol = {
      ...slide([
        {
          type: 'text',
          pos: { x: 0, y: 0, w: 4, h: 0.4 },
          text: '既定の文字サイズ',
        } as PptxElement,
      ]),
      designDefaults: true,
    };
    expect(predictPptxTextBoxes(protocol).boxes[0]!.fontSizePt).toBe(14);
  });
});

describe('compareRenderedTextRuns (post-render)', () => {
  const label: PptxElement = {
    type: 'shape',
    shapeType: 'rect',
    pos: { x: 1, y: 1, w: 2, h: 0.4 },
    text: '検証環境の準備',
    style: { fontSize: 10, align: 'center', valign: 'middle' },
  };
  const run = (text: string, x: number, baseline: number, size = 10): RenderedTextRun => ({
    page: 1,
    text,
    x,
    width: (Array.from(text).length * size) / 72,
    baseline,
    fontSizePt: size,
  });

  it('reports a wrap and an overflow measured in the render', () => {
    const { boxes } = predictPptxTextBoxes(slide([label]));
    const ok = compareRenderedTextRuns(boxes, [run('検証環境の準備', 1.5, 1.25)]);
    expect(ok.issues).toEqual([]);
    expect(ok.boxes[0]).toMatchObject({ predictedLines: 1, renderedLines: 1 });

    const wrapped = compareRenderedTextRuns(boxes, [
      run('検証環境の', 1.5, 1.15),
      run('準備', 1.8, 1.32),
    ]);
    expect(wrapped.issues.map((i) => i.kind)).toEqual(['unexpected_wrap']);

    const spilled = compareRenderedTextRuns(boxes, [
      run('検証環境', 1.5, 1.1),
      run('の', 1.5, 1.27),
      run('準備', 1.5, 1.44),
    ]);
    expect(spilled.issues.map((i) => i.kind)).toEqual(['unexpected_wrap', 'overflow']);
    expect(spilled.issues[1]!.source).toBe('render');
  });

  it('tells side-by-side boxes on one baseline apart by text', () => {
    const left = { ...label, text: '準備', pos: { x: 1, y: 1, w: 1, h: 0.4 } };
    const right = { ...label, text: '確認', pos: { x: 2.05, y: 1, w: 1, h: 0.4 } };
    const { boxes } = predictPptxTextBoxes(slide([left, right]));
    const result = compareRenderedTextRuns(boxes, [run('準備', 1.9, 1.25), run('確認', 2.1, 1.25)]);
    expect(result.boxes.map((b) => b.renderedLines)).toEqual([1, 1]);
    expect(result.unmatchedElements).toBe(0);
  });

  it('does not pass when authored text cannot be matched to the PDF', () => {
    const { boxes } = predictPptxTextBoxes(slide([label]));
    const result = compareRenderedTextRuns(boxes, [run('別の資料', 1.5, 1.25)]);
    expect(result).toMatchObject({
      status: 'inconclusive',
      checkedElements: 0,
      unmatchedElements: 1,
    });
  });

  it('reports incomplete coverage when only some authored text matches the PDF', () => {
    const other = { ...label, text: '確認', pos: { x: 3, y: 1, w: 1, h: 0.4 } };
    const { boxes } = predictPptxTextBoxes(slide([label, other]));
    const result = compareRenderedTextRuns(boxes, [run('検証環境の準備', 1.5, 1.25)]);
    expect(result).toMatchObject({
      status: 'inconclusive',
      checkedElements: 1,
      unmatchedElements: 1,
    });
  });

  it('does not count blank authored lines as missing rendered lines', () => {
    const el = { ...label, text: '見出し\n\n本文', pos: { x: 1, y: 1, w: 2, h: 0.8 } };
    const { boxes } = predictPptxTextBoxes(slide([el]));
    const result = compareRenderedTextRuns(boxes, [
      run('見出し', 1.6, 1.2),
      run('本文', 1.7, 1.53),
    ]);
    expect(result.boxes[0]).toMatchObject({ predictedLines: 2, renderedLines: 2 });
    expect(result.issues).toEqual([]);
  });

  it('converts pdf.js items to top-left inch coordinates and drops blank and rotated runs', () => {
    const runs = pdfTextItemsToRuns(
      [
        { str: '検証', transform: [10, 0, 0, 10, 72, 540 - 90], width: 20 },
        { str: ' ', transform: [10, 0, 0, 10, 92, 450], width: 600 },
        { str: '縦', transform: [0, 10, -10, 0, 100, 100], width: 10 },
      ],
      2,
      540
    );
    expect(runs).toEqual([
      { page: 2, text: '検証', x: 1, width: 20 / 72, baseline: 1.25, fontSizePt: 10 },
    ]);
  });
});

describe.skipIf(!resolveSofficeBinary({ refresh: true }))('LibreOffice calibration', () => {
  const dir = pathResolver.sharedTmp(`protocol-text-fit-${process.pid}`);
  afterAll(() => safeRmSync(dir, { recursive: true, force: true }));

  it('renders the fixture with the same issues and line counts the model predicts', async () => {
    safeMkdir(dir, { recursive: true });
    const protocol = buildTextFitFixtureProtocol();
    const pptx = `${dir}/fixture.pptx`;
    await generateNativePptx(protocol, pptx);
    const converted = convertDocumentToPdf({ sourcePath: pptx, label: 'text-fit', workDir: dir });
    expect(converted.available, converted.unavailable_reason).toBe(true);
    const { runs } = await extractPdfTextRuns(
      safeReadFile(converted.pdfPath!, { encoding: null }) as Buffer
    );
    const { boxes, skipped } = predictPptxTextBoxes(protocol);
    const rendered = compareRenderedTextRuns(boxes, runs, skipped.length);
    expect(rendered.unmatchedElements).toBe(0);
    expect(flagged(protocol, rendered.issues)).toEqual(EXPECTED);
    for (const box of rendered.boxes) {
      expect(box.renderedLines, box.excerpt).toBe(box.predictedLines);
    }
  }, 120_000);
});
