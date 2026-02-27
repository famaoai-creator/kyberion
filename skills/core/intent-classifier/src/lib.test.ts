import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import { loadRules, classifyIntent } from './lib';
import * as classifier from '@agent/core/classifier';

vi.mock('node:fs');
vi.mock('@agent/core/classifier');

describe('intent-classifier lib', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should load rules correctly from yaml', () => {
    const mockYaml = `
resultKey: intent
categories:
  request: [please, do]
  question: [what, how]
`;
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(mockYaml);

    const rules = loadRules('dummy.yml');
    expect(rules.resultKey).toBe('intent');
    expect(rules.categories.request).toContain('please');
  });

  it('should call classifyFile with correct parameters', () => {
    const rules = {
      resultKey: 'intent',
      categories: { request: ['do'] },
    };

    classifyIntent('test.txt', rules);

    expect(classifier.classifyFile).toHaveBeenCalledWith('test.txt', rules.categories, {
      resultKey: 'intent',
    });
  });
});
