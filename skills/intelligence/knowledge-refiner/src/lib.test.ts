import { describe, it, expect, vi, beforeEach } from 'vitest';
import { findDuplicates } from './lib';

describe('knowledge-refiner lib', () => {
  it('should detect exact duplicates', () => {
    const mockFiles = [
      { path: 'a.md', content: 'same content', size: 10, lines: 1, words: 2, modified: '' },
      { path: 'b.md', content: 'same content', size: 10, lines: 1, words: 2, modified: '' },
    ] as any;
    const duplicates = findDuplicates(mockFiles);
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0].type).toBe('exact');
  });

  it('should detect similar duplicates', () => {
    const longContent1 =
      'this is a long enough content to test similarity between two files. it needs more than twenty words to trigger the similarity detection logic in the refiner engine.';
    const longContent2 =
      'this IS a long enough content to test similarity between two FILES. it needs more than twenty words to trigger the similarity detection logic in the refiner engine.';

    const mockFiles = [
      { path: 'a.md', content: longContent1, size: 200, lines: 1, words: 30, modified: '' },
      { path: 'b.md', content: longContent2, size: 200, lines: 1, words: 30, modified: '' },
    ] as any;

    const duplicates = findDuplicates(mockFiles);
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0].type).toBe('similar');
    expect(duplicates[0].similarity).toBeGreaterThan(90);
  });
});
