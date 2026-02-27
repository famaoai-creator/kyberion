import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import { saveFact, searchMemory } from './lib';
import * as pathResolver from '@agent/core/path-resolver';

vi.mock('node:fs');
vi.mock('@agent/core/path-resolver');

describe('sovereign-memory lib', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(pathResolver.shared).mockReturnValue('/tmp/memory');
  });

  it('should save a fact', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const entry = saveFact('Gemini is an agent');
    expect(entry.fact).toBe('Gemini is an agent');
    expect(fs.writeFileSync).toHaveBeenCalled();
  });

  it('should search facts', () => {
    const mockRegistry = {
      facts: [
        { fact: 'Apple is a fruit', category: 'food' },
        { fact: 'Gemini is an agent', category: 'ai' },
      ],
    };
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockRegistry));

    const results = searchMemory('gemini');
    expect(results).toHaveLength(1);
    expect(results[0].fact).toContain('Gemini');
  });
});
