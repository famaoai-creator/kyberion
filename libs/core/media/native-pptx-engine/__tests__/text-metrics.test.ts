/**
 * MP-03: text measurement and layout fit. These are the regression cases the
 * old ratio-based splitter got wrong — long Japanese bodies, bullet-heavy
 * slides, and mixed CJK/latin runs that overflowed their boxes silently.
 */
import { describe, it, expect } from 'vitest';
import {
  fitTextToBox,
  isFullwidthChar,
  measureTextBlock,
  measureTextWidthPt,
  splitLinesBalanced,
  wrapLine,
} from '../text-metrics.js';

describe('character classification', () => {
  it('recognizes kana, kanji and fullwidth forms as fullwidth', () => {
    for (const ch of ['あ', 'ア', '漢', '、', 'Ａ']) {
      expect(isFullwidthChar(ch)).toBe(true);
    }
    for (const ch of ['a', 'Z', '1', ' ', '.']) {
      expect(isFullwidthChar(ch)).toBe(false);
    }
  });

  it('measures Japanese roughly twice as wide as latin lowercase', () => {
    const jp = measureTextWidthPt('あいうえお', 12);
    const latin = measureTextWidthPt('abcde', 12);
    expect(jp).toBeGreaterThan(latin * 1.7);
  });
});

describe('wrapLine', () => {
  it('breaks Japanese text between any two characters', () => {
    const line = 'これは日本語の長い行であり折り返しが必要です';
    const wrapped = wrapLine(line, 60, 12);
    expect(wrapped.length).toBeGreaterThan(1);
    expect(wrapped.join('')).toBe(line);
  });

  it('prefers space breaks for latin text', () => {
    const wrapped = wrapLine('the quick brown fox jumps over the lazy dog', 80, 12);
    expect(wrapped.length).toBeGreaterThan(1);
    for (const rendered of wrapped) {
      expect(rendered.startsWith(' ')).toBe(false);
      expect(rendered.endsWith(' ')).toBe(false);
    }
  });

  it('breaks mid-word when a single word exceeds the measure', () => {
    const wrapped = wrapLine('supercalifragilisticexpialidocious', 40, 12);
    expect(wrapped.length).toBeGreaterThan(1);
    expect(wrapped.join('')).toBe('supercalifragilisticexpialidocious');
  });

  it('is deterministic across repeated calls', () => {
    const line = '日本語とlatinが混在するmixed content行です';
    expect(wrapLine(line, 70, 12)).toEqual(wrapLine(line, 70, 12));
  });
});

describe('measureTextBlock', () => {
  it('counts wrapped lines per paragraph and accounts for margins', () => {
    const text = ['短い行', 'これはとても長い日本語の行であり確実に折り返される内容です'].join(
      '\n'
    );
    const measured = measureTextBlock(text, {
      fontSizePt: 13,
      widthIn: 4.45,
      marginIn: [0.1, 0.06, 0.06, 0.08],
      lineSpacingPct: 155,
    });
    expect(measured.linesPerParagraph[0]).toBe(1);
    expect(measured.linesPerParagraph[1]).toBeGreaterThan(1);
    expect(measured.lineCount).toBe(measured.linesPerParagraph.reduce((sum, n) => sum + n, 0));
    // Margins are inside the required height.
    expect(measured.requiredHeightIn).toBeGreaterThan(0.16);
  });

  it('grows required height with font size', () => {
    const text = 'これは折り返しが発生する程度の長さを持つ日本語の本文です';
    const small = measureTextBlock(text, { fontSizePt: 10, widthIn: 4 });
    const large = measureTextBlock(text, { fontSizePt: 18, widthIn: 4 });
    expect(large.requiredHeightIn).toBeGreaterThan(small.requiredHeightIn);
  });
});

describe('fitTextToBox', () => {
  const box = { widthIn: 9.15, heightIn: 4.55, marginIn: [0.1, 0.06, 0.06, 0.08] as const };

  it('keeps the designed size when the text already fits', () => {
    const result = fitTextToBox({
      text: '要点は3つあります',
      fontSizePt: 13,
      minFontSizePt: 10,
      widthIn: box.widthIn,
      heightIn: box.heightIn,
      marginIn: [...box.marginIn],
      lineSpacingPct: 155,
    });
    expect(result.strategy).toBe('as-designed');
    expect(result.fontSizePt).toBe(13);
    expect(result.fits).toBe(true);
    expect(result.fillRatio).toBeLessThan(1);
  });

  it('shrinks within the ramp floor for a long Japanese body', () => {
    // 9 bullets that each wrap to two lines — 18 rendered lines, which
    // overflows a 4.55in box at 13pt but fits once shrunk toward the floor.
    const longJapanese = Array.from(
      { length: 9 },
      (_, i) =>
        `${i + 1}. 本施策では既存の業務プロセスを段階的に自動化し、担当者の確認負荷を下げながら品質を維持します。加えて監査証跡を自動で残すため、運用開始後の検証コストも継続的に低減できます。`
    ).join('\n');
    const result = fitTextToBox({
      text: longJapanese,
      fontSizePt: 13,
      minFontSizePt: 10,
      widthIn: box.widthIn,
      heightIn: box.heightIn,
      marginIn: [...box.marginIn],
      lineSpacingPct: 155,
    });
    expect(result.strategy).toBe('shrunk');
    expect(result.fontSizePt).toBeLessThan(13);
    expect(result.fontSizePt).toBeGreaterThanOrEqual(10);
    expect(result.fits).toBe(true);
    expect(result.measurement.requiredHeightIn).toBeLessThanOrEqual(box.heightIn);
  });

  it('never shrinks below the floor and reports where to split', () => {
    const hugeBody = Array.from(
      { length: 60 },
      (_, i) => `${i + 1}. 想定を大きく超える分量の本文がこのスライドに流し込まれています。`
    ).join('\n');
    const result = fitTextToBox({
      text: hugeBody,
      fontSizePt: 13,
      minFontSizePt: 10,
      widthIn: box.widthIn,
      heightIn: box.heightIn,
      marginIn: [...box.marginIn],
      lineSpacingPct: 155,
    });
    expect(result.fits).toBe(false);
    expect(result.strategy).toBe('overflow');
    expect(result.fontSizePt).toBe(10);
    expect(result.fillRatio).toBeGreaterThan(1);
    expect(result.overflowAtParagraph).toBeGreaterThan(0);
    expect(result.overflowAtParagraph).toBeLessThan(60);
  });

  it('is deterministic for the same request', () => {
    const request = {
      text: 'bullet 一覧\n・項目A\n・項目B とても長い説明が続く場合の折り返し確認用テキスト',
      fontSizePt: 13,
      minFontSizePt: 10,
      widthIn: 4.45,
      heightIn: 2.0,
      marginIn: [0.1, 0.06, 0.06, 0.08] as [number, number, number, number],
      lineSpacingPct: 155,
    };
    expect(fitTextToBox(request)).toEqual(fitTextToBox(request));
  });
});

describe('splitLinesBalanced', () => {
  it('balances by rendered height, not item count', () => {
    const lines = [
      '極めて長い最初の項目であり、この一行だけで複数行に折り返されるだけの分量を持っています。さらに続きます。',
      '短い',
      '短い',
      '短い',
    ];
    const { left, right } = splitLinesBalanced({
      lines,
      columnWidthIn: 4.45,
      fontSizePt: 13,
      lineSpacingPct: 155,
    });
    // The old ratio split (ceil(4 * 0.55) = 3) put three lines left; measuring
    // puts the one heavy line alone against the three short ones.
    expect(left).toEqual([lines[0]]);
    expect(right).toEqual([lines[1], lines[2], lines[3]]);
  });

  it('keeps both columns non-empty', () => {
    const { left, right } = splitLinesBalanced({
      lines: ['a', 'b'],
      columnWidthIn: 4.45,
      fontSizePt: 13,
    });
    expect(left.length).toBeGreaterThan(0);
    expect(right.length).toBeGreaterThan(0);
  });

  it('returns a single column for a single line', () => {
    const { left, right } = splitLinesBalanced({
      lines: ['only'],
      columnWidthIn: 4.45,
      fontSizePt: 13,
    });
    expect(left).toEqual(['only']);
    expect(right).toEqual([]);
  });
});
