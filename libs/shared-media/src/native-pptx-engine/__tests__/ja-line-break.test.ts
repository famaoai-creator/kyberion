import { describe, expect, it } from 'vitest';
import {
  balanceJaHeading,
  kinsokuAllowsBreak,
  phraseBreakOpportunities,
} from '../ja-line-break.js';
import { measureTextWidthPt, wrapLine } from '../text-metrics.js';

describe('Japanese line breaking', () => {
  it('applies kinsoku: no 。、」 or small kana at line start, no 「 at line end', () => {
    expect(kinsokuAllowsBreak('る', '。')).toBe(false);
    expect(kinsokuAllowsBreak('ん', 'ょ')).toBe(false);
    expect(kinsokuAllowsBreak('「', '計')).toBe(false);
    expect(kinsokuAllowsBreak('る', '計')).toBe(true);
  });

  it('prefers breaks where a particle run hands over to a content word', () => {
    const text = '曖昧な依頼を成果まで運ぶ';
    const cuts = phraseBreakOpportunities(text).map((i) => Array.from(text).slice(0, i).join(''));
    expect(cuts).toContain('曖昧な');
    expect(cuts).toContain('曖昧な依頼を');
  });

  it('keeps honorific prefixes with their word', () => {
    const text = 'デジタルオンボーディング変革のご提案';
    const cuts = phraseBreakOpportunities(text).map((i) => Array.from(text).slice(0, i).join(''));
    expect(cuts).not.toContain('デジタルオンボーディング変革のご');
    expect(cuts).toContain('デジタルオンボーディング変革の');
  });

  it('never starts a wrapped line with punctuation or small kana', () => {
    const line =
      '意図を合意し、検証可能な活動定義に変換してから、安全なサンドボックスで実行します。';
    for (const width of [60, 84, 100, 132, 150]) {
      const wrapped = wrapLine(line, width, 12);
      expect(wrapped.join('')).toBe(line);
      for (const rendered of wrapped.slice(1)) {
        expect('、。」ゃゅょっー').not.toContain(rendered[0]);
      }
    }
  });

  it('balances a two-line heading on a phrase boundary instead of orphaning kana', () => {
    const heading = 'Kyberionは曖昧な指示をそのまま実行しません';
    const measure = (value: string) => measureTextWidthPt(value, 40);
    const width = measure(heading) * 0.9;
    const balanced = balanceJaHeading(heading, width, measure);
    const lines = balanced.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines.join('')).toBe(heading);
    // Neither line is a stub like 「ん」.
    expect(Math.min(...lines.map((line) => line.length))).toBeGreaterThan(5);
    expect(balanceJaHeading('短い見出し', 1000, measure)).toBe('短い見出し');
  });
});
