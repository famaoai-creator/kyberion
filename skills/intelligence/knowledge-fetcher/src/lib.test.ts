import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import { searchKnowledge } from './lib';

vi.mock('node:fs');

describe('knowledge-fetcher lib', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should find files containing the query in content', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readdirSync).mockReturnValue(['test.md'] as any);
    vi.mocked(fs.statSync).mockReturnValue({
      isDirectory: () => false,
      isFile: () => true,
      size: 100,
    } as any);
    vi.mocked(fs.readFileSync).mockReturnValue('This is a test knowledge content.');

    const results = searchKnowledge('/knowledge', 'test');
    expect(results).toHaveLength(1);
    expect(results[0].path).toContain('test.md');
  });

  it('should find files containing the query in filename', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readdirSync).mockReturnValue(['query-match.txt'] as any);
    vi.mocked(fs.statSync).mockReturnValue({
      isDirectory: () => false,
      isFile: () => true,
      size: 100,
    } as any);
    vi.mocked(fs.readFileSync).mockReturnValue('No match here.');

    const results = searchKnowledge('/knowledge', 'query');
    expect(results).toHaveLength(1);
    expect(results[0].path).toContain('query-match.txt');
  });

  it('should respect maxDepth', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readdirSync).mockReturnValue(['subdir'] as any);
    vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => true } as any);

    const results = searchKnowledge('/knowledge', 'test', { maxDepth: 0 });
    // Should not recurse because current depth (0) is already at maxDepth (0)
    // Wait, the logic is: if (depth > maxDepth) return results;
    // So if depth=0 and maxDepth=0, it will process the first level but not recurse.
    // Let's check our implementation.
    expect(fs.readdirSync).toHaveBeenCalledTimes(1);
  });
});
