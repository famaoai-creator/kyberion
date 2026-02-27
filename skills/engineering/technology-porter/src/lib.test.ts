import { describe, it, expect } from 'vitest';
import { detectLanguage, analyzeSource, estimateMigration } from './lib';

describe('technology-porter', () => {
  it('detects language by extension', () => {
    expect(detectLanguage('test.js')).toBe('javascript');
    expect(detectLanguage('test.py')).toBe('python');
    expect(detectLanguage('test.rs')).toBe('rust');
  });

  it('analyzes source complexity', () => {
    const jsCode = `
      function a() {}
      function b() {}
      class C {}
      import fs from 'fs';
    `;
    const analysis = analyzeSource(jsCode, 'javascript');
    expect(analysis.functions).toBe(2);
    expect(analysis.classes).toBe(1);
    expect(analysis.imports).toBe(1);
    expect(analysis.complexity).toBe('low');
  });

  it('estimates migration effort', () => {
    const analysis = {
      lines: 100,
      functions: 5,
      classes: 1,
      imports: 2,
      complexity: 'low' as const,
    };
    const estimate = estimateMigration(analysis, 'javascript', 'python');
    expect(estimate.idiomRulesAvailable).toBeGreaterThan(0);
    expect(estimate.estimatedEffort).toBe('straightforward');
  });
});
