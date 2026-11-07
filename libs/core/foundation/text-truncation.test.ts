import { describe, expect, it } from 'vitest';
import { truncateText, truncateTextWithCount } from './text-truncation.js';

describe('text-truncation', () => {
  it('truncates text without changing short strings', () => {
    expect(truncateText('hello', 10)).toBe('hello');
    expect(truncateText('hello world', 5)).toBe('hello');
  });

  it('reports omitted count alongside the preview text', () => {
    expect(truncateTextWithCount('abcdefgh', 5)).toEqual({
      text: 'abcde',
      omitted_count: 3,
    });
  });
});
