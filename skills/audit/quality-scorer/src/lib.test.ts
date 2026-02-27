import { describe, it, expect } from 'vitest';
import { calculateScore, estimateComplexity, DEFAULT_RULES } from './lib';

describe('quality-scorer', () => {
  it('calculates score for good content', () => {
    const content = 'This is a good sentence. It has enough length. And it is not too complex.';
    const longContent = content.repeat(10);
    const result = calculateScore(longContent);
    expect(result.score).toBe(100);
    expect(result.issues).toHaveLength(0);
  });

  it('penalizes short content', () => {
    const content = 'Short.';
    const result = calculateScore(content);
    expect(result.score).toBeLessThan(100);
    expect(result.issues).toContain(DEFAULT_RULES.min_length.message);
  });

  it('penalizes complexity', () => {
    const complex = 'if (a) { if (b) { while(c) { case d: } } } && || && ||';
    const result = calculateScore(complex.repeat(5));
    expect(result.metrics.complexity).toBeGreaterThan(15);
    expect(result.score).toBeLessThan(100);
  });
});
