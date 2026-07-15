/**
 * LE-01: design-defaults cascade — opt-in normalization that fills missing
 * style keys consistently so snapshot/brief protocols render with the same
 * balance as hand-written builder scripts.
 */
import { describe, it, expect } from 'vitest';
import { applyPptxDesignDefaults, resolvePptxDesignDefaults } from '../design-cascade.js';
import type { PptxDesignProtocol, PptxElement } from '../../types/pptx-protocol.js';

function baseProtocol(overrides: Partial<PptxDesignProtocol> = {}): PptxDesignProtocol {
  return {
    version: '1.0.0',
    generatedAt: '2026-07-15T00:00:00.000Z',
    canvas: { w: 10, h: 7.5 },
    theme: {},
    master: { elements: [] },
    slides: [
      {
        id: 'slide1',
        elements: [
          { type: 'text', pos: { x: 1, y: 1, w: 4, h: 1 }, text: 'タイトル' },
          {
            type: 'shape',
            pos: { x: 1, y: 2, w: 4, h: 1 },
            text: 'カード',
            shapeType: 'roundRect',
          },
          { type: 'line', pos: { x: 1, y: 3, w: 4, h: 0 } },
        ],
      },
    ],
    ...overrides,
  };
}

describe('design-cascade (LE-01)', () => {
  it('is a no-op (same reference) when designDefaults is absent', () => {
    const protocol = baseProtocol();
    expect(applyPptxDesignDefaults(protocol)).toBe(protocol);
  });

  it('is a no-op in rawParts passthrough mode', () => {
    const protocol = baseProtocol({
      designDefaults: true,
      rawParts: { 'ppt/presentation.xml': 'AAAA' },
    });
    expect(applyPptxDesignDefaults(protocol)).toBe(protocol);
  });

  it('fills missing text/shape/line style keys with built-in defaults', () => {
    const result = applyPptxDesignDefaults(baseProtocol({ designDefaults: true }));
    const [text, shape, line] = result.slides[0].elements;

    expect(text.style?.fontSize).toBe(14);
    expect(text.style?.fontFamily).toBeTruthy();
    expect(text.style?.color).toBe('#0f172a');

    expect(shape.style?.fontSize).toBe(12);
    expect(shape.style?.fontFamily).toBe(text.style?.fontFamily);
    // shape text keeps inheriting the theme text color
    expect(shape.style?.color).toBeUndefined();

    expect(line.style?.line).toBe('#94a3b8');
    expect(line.style?.lineWidth).toBe(1);
  });

  it('never overwrites explicit style values', () => {
    const protocol = baseProtocol({ designDefaults: true });
    protocol.slides[0].elements[0].style = {
      fontSize: 28,
      fontFamily: 'Meiryo',
      color: '#ff0000',
    };
    protocol.slides[0].elements[2].style = { line: '#000000', lineWidth: 2.5 };

    const result = applyPptxDesignDefaults(protocol);
    expect(result.slides[0].elements[0].style).toMatchObject({
      fontSize: 28,
      fontFamily: 'Meiryo',
      color: '#ff0000',
    });
    expect(result.slides[0].elements[2].style).toMatchObject({
      line: '#000000',
      lineWidth: 2.5,
    });
  });

  it('honors per-key overrides in the designDefaults object', () => {
    const result = applyPptxDesignDefaults(
      baseProtocol({
        designDefaults: { fontFamily: 'Yu Gothic', textFontSize: 16 },
      })
    );
    const [text, shape] = result.slides[0].elements;
    expect(text.style?.fontFamily).toBe('Yu Gothic');
    expect(text.style?.fontSize).toBe(16);
    expect(shape.style?.fontFamily).toBe('Yu Gothic');
    expect(shape.style?.fontSize).toBe(12);
  });

  it('derives fontFamily from theme minorFont when present', () => {
    const defaults = resolvePptxDesignDefaults({ theme: { minorFont: 'Yu Gothic' } }, true);
    expect(defaults?.fontFamily).toBe('Yu Gothic');
  });

  it('leaves shapes without text and non-text element types untouched', () => {
    const image: PptxElement = {
      type: 'image',
      pos: { x: 0, y: 0, w: 1, h: 1 },
      imagePath: '/tmp/x.png',
    };
    const emptyShape: PptxElement = {
      type: 'shape',
      pos: { x: 0, y: 0, w: 1, h: 1 },
      shapeType: 'rect',
    };
    const protocol = baseProtocol({ designDefaults: true });
    protocol.slides[0].elements = [image, emptyShape];

    const result = applyPptxDesignDefaults(protocol);
    expect(result.slides[0].elements[0]).toEqual(image);
    expect(result.slides[0].elements[1].style).toBeUndefined();
  });

  it('cascades master elements too', () => {
    const protocol = baseProtocol({ designDefaults: true });
    protocol.master.elements = [
      { type: 'text', pos: { x: 0, y: 0, w: 2, h: 0.5 }, text: 'footer' },
    ];
    const result = applyPptxDesignDefaults(protocol);
    expect(result.master.elements[0].style?.fontSize).toBe(14);
  });

  it('treats textRuns-only elements as text-bearing', () => {
    const protocol = baseProtocol({ designDefaults: true });
    protocol.slides[0].elements = [
      {
        type: 'text',
        pos: { x: 0, y: 0, w: 2, h: 0.5 },
        textRuns: [{ text: 'run' }],
      },
    ];
    const result = applyPptxDesignDefaults(protocol);
    expect(result.slides[0].elements[0].style?.fontSize).toBe(14);
  });
});
