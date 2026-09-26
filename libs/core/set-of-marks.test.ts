import { describe, expect, it } from 'vitest';
import {
  candidatesFromDomSnapshot,
  candidatesFromOcr,
  coverageRatio,
  fuseSetOfMarks,
  iou,
  sortReadingOrder,
  type SomCandidate,
} from './set-of-marks.js';
import type { OcrResult } from './ocr-types.js';

function text(x: number, y: number, width: number, height: number, label: string, score = 0.9) {
  return {
    box: { x, y, width, height },
    source: 'ocr',
    kind: 'text',
    label,
    score,
  } satisfies SomCandidate;
}

function control(x: number, y: number, width: number, height: number, ref?: string, score = 1) {
  return {
    box: { x, y, width, height },
    source: 'dom',
    kind: 'control',
    score,
    ...(ref ? { ref } : {}),
  } satisfies SomCandidate;
}

describe('box geometry', () => {
  it.each([
    [{ x: 0, y: 0, width: 10, height: 10 }, { x: 0, y: 0, width: 10, height: 10 }, 1],
    [{ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 0, width: 10, height: 10 }, 50 / 150],
    [{ x: 0, y: 0, width: 10, height: 10 }, { x: 20, y: 20, width: 5, height: 5 }, 0],
  ])('iou(%o, %o) = %d', (a, b, expected) => {
    expect(iou(a, b)).toBeCloseTo(expected, 6);
  });

  it('coverage is measured against the inner box', () => {
    const inner = { x: 0, y: 0, width: 10, height: 10 };
    const outer = { x: 3, y: 0, width: 100, height: 100 };
    expect(coverageRatio(inner, outer)).toBeCloseTo(0.7, 6);
    expect(coverageRatio(outer, inner)).toBeCloseTo(70 / 10000, 6);
  });
});

describe('icon-over-text suppression', () => {
  it.each([
    ['fully inside', text(110, 105, 60, 20, 'Save'), true],
    ['exactly at 0.7 coverage', text(70, 105, 100, 20, 'Save'), true],
    ['below 0.7 coverage', text(69, 105, 100, 20, 'Save'), false],
    ['outside', text(400, 105, 60, 20, 'Save'), false],
  ])('%s', (_name, label, absorbed) => {
    const marks = fuseSetOfMarks([control(100, 100, 100, 30, '@e1'), label]);
    if (absorbed) {
      expect(marks).toHaveLength(1);
      expect(marks[0]).toMatchObject({ ref: '@e1', label: 'Save', sources: ['dom', 'ocr'] });
    } else {
      expect(marks).toHaveLength(2);
      expect(marks.find((mark) => mark.ref === '@e1')?.label).toBeUndefined();
    }
  });

  it('keeps an existing control label and gives nested text to the smallest container', () => {
    const marks = fuseSetOfMarks([
      { ...control(0, 0, 400, 300, '@e1'), label: 'Dialog' },
      control(100, 100, 100, 30, '@e2'),
      text(110, 105, 60, 20, 'OK'),
    ]);
    expect(marks.find((mark) => mark.ref === '@e1')?.label).toBe('Dialog');
    expect(marks.find((mark) => mark.ref === '@e2')?.label).toBe('OK');
    expect(marks).toHaveLength(2);
  });
});

describe('non-maximum suppression', () => {
  it.each([
    ['identical boxes merge', { x: 0, y: 0, width: 50, height: 20 }, 1],
    ['IoU above 0.5 merges', { x: 5, y: 0, width: 50, height: 20 }, 1],
    ['IoU at or below 0.5 stays separate', { x: 17, y: 0, width: 50, height: 20 }, 2],
  ])('%s', (_name, box, expected) => {
    const marks = fuseSetOfMarks([
      {
        box: { x: 0, y: 0, width: 50, height: 20 },
        source: 'detector',
        kind: 'icon',
        score: 0.4,
      },
      { box, source: 'detector', kind: 'icon', score: 0.8, label: 'gear' },
    ]);
    expect(marks).toHaveLength(expected);
  });

  it('keeps the stronger box and merges provenance, label and ref', () => {
    const marks = fuseSetOfMarks([
      { box: { x: 2, y: 0, width: 50, height: 20 }, source: 'detector', kind: 'icon', score: 0.9 },
      control(0, 0, 50, 20, '@e7', 0.5),
    ]);
    expect(marks).toEqual([
      expect.objectContaining({
        box: { x: 2, y: 0, width: 50, height: 20 },
        kind: 'icon',
        ref: '@e7',
        sources: ['dom', 'detector'],
      }),
    ]);
  });
});

describe('reading-order numbering', () => {
  it('numbers top to bottom, left to right with a 12px row tolerance', () => {
    const marks = fuseSetOfMarks([
      text(300, 10, 40, 20, 'C'),
      text(10, 18, 40, 20, 'A'), // 8px lower than C: same row
      text(150, 22, 40, 20, 'B'), // 12px lower than C: still same row
      text(10, 60, 40, 20, 'D'),
      text(200, 35, 40, 20, 'E'), // 25px lower than C: next row, above D
    ]);
    expect(marks.map((mark) => `${mark.n}:${mark.label}`)).toEqual([
      '1:A',
      '2:B',
      '3:C',
      '4:E',
      '5:D',
    ]);
    expect(marks[0].center).toEqual({ x: 30, y: 28 });
  });

  it('row tolerance is measured from the first item in the row', () => {
    const ordered = sortReadingOrder(
      [
        { box: { x: 90, y: 0, width: 10, height: 10 }, id: 'a' },
        { box: { x: 50, y: 10, width: 10, height: 10 }, id: 'b' },
        { box: { x: 0, y: 20, width: 10, height: 10 }, id: 'c' },
      ],
      12
    );
    expect(ordered.map((item) => item.id)).toEqual(['b', 'a', 'c']);
  });

  it('drops degenerate boxes, clips to the image and caps the mark count', () => {
    const marks = fuseSetOfMarks(
      [
        text(0, 0, 0, 10, 'zero'),
        text(Number.NaN, 0, 10, 10, 'nan'),
        text(500, 500, 10, 10, 'outside'),
        text(90, 0, 40, 10, 'clipped'),
        text(0, 50, 10, 10, 'second'),
      ],
      { imageSize: { width: 100, height: 100 }, maxMarks: 1 }
    );
    expect(marks).toEqual([
      expect.objectContaining({
        n: 1,
        label: 'clipped',
        box: { x: 90, y: 0, width: 10, height: 10 },
      }),
    ]);
  });
});

describe('candidatesFromOcr', () => {
  const base: OcrResult = {
    status: 'succeeded',
    provider: 'tesseract',
    text: '',
    confidence: 90,
    elapsedMs: 1,
    lines: [
      { text: ' File  menu ', confidence: 85, boundingBox: { x: 10, y: 20, width: 30, height: 8 } },
      { text: '', confidence: 99, boundingBox: { x: 0, y: 0, width: 5, height: 5 } },
      { text: 'no box', confidence: 99 },
    ],
  };

  it('treats undeclared units as pixels and normalises 0..100 confidence', () => {
    expect(candidatesFromOcr(base, { width: 200, height: 100 })).toEqual([
      {
        box: { x: 10, y: 20, width: 30, height: 8 },
        source: 'ocr',
        kind: 'text',
        label: 'File menu',
        score: 0.85,
      },
    ]);
  });

  it('scales normalized boxes to image pixels', () => {
    const result: OcrResult = {
      ...base,
      provider: 'apple_vision',
      boundingBoxUnits: 'normalized',
      lines: [
        { text: 'OK', confidence: 0.5, boundingBox: { x: 0.25, y: 0.5, width: 0.1, height: 0.05 } },
      ],
    };
    expect(candidatesFromOcr(result, { width: 200, height: 100 })).toEqual([
      expect.objectContaining({ box: { x: 50, y: 50, width: 20, height: 5 }, score: 0.5 }),
    ]);
  });

  it('returns nothing for a failed result', () => {
    expect(candidatesFromOcr({ ...base, status: 'failed' }, { width: 1, height: 1 })).toEqual([]);
  });
});

describe('candidatesFromDomSnapshot', () => {
  it('scales CSS pixels by device pixel ratio and keeps refs', () => {
    const candidates = candidatesFromDomSnapshot(
      [
        {
          ref: '@e1',
          name: 'Search',
          text: 'ignored',
          bbox: { x: 10, y: 5, width: 100, height: 20 },
        },
        { ref: '@e2', name: '', text: 'Sign in', bbox: { x: 0, y: 40, width: 50, height: 10 } },
        { ref: '@e3', name: 'no bbox' },
        { ref: '@e4', name: 'hidden', visible: false, bbox: { x: 0, y: 0, width: 5, height: 5 } },
      ],
      { scale: 2 }
    );
    expect(candidates).toEqual([
      {
        box: { x: 20, y: 10, width: 200, height: 40 },
        source: 'dom',
        kind: 'control',
        label: 'Search',
        score: 1,
        ref: '@e1',
      },
      {
        box: { x: 0, y: 80, width: 100, height: 20 },
        source: 'dom',
        kind: 'control',
        label: 'Sign in',
        score: 1,
        ref: '@e2',
      },
    ]);
  });

  it('fuses DOM controls with OCR text of the same screenshot', () => {
    const dom = candidatesFromDomSnapshot(
      [{ ref: '@e1', name: '', bbox: { x: 50, y: 50, width: 60, height: 20 } }],
      { scale: 2 }
    );
    const ocr = candidatesFromOcr(
      {
        status: 'succeeded',
        provider: 'apple_vision',
        boundingBoxUnits: 'normalized',
        text: 'Go',
        confidence: 90,
        elapsedMs: 1,
        lines: [
          {
            text: 'Go',
            confidence: 90,
            boundingBox: { x: 0.11, y: 0.105, width: 0.05, height: 0.03 },
          },
        ],
      },
      { width: 1000, height: 1000 }
    );
    expect(fuseSetOfMarks([...ocr, ...dom])).toEqual([
      expect.objectContaining({ n: 1, ref: '@e1', label: 'Go', sources: ['dom', 'ocr'] }),
    ]);
  });
});
