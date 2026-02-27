import { describe, it, expect, vi, beforeEach } from 'vitest';
import { detectStack } from './lib';
import * as fs from 'node:fs';

vi.mock('node:fs');

describe('tech-stack-librarian lib', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should detect tech from package.json', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ dependencies: { typescript: '1.0' } })
    );
    const result = detectStack('.', { typescript: { category: 'Lang' } });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('typescript');
  });
});
