import { describe, expect, it } from 'vitest';
import { pageFunctionSource } from './browser-pipeline-op-handlers.js';

describe('browser:evaluate with args', () => {
  it('hands Playwright a function-typed page function carrying the authored source', () => {
    const source = '(a) => document.title + a.suffix';
    const pageFunction = pageFunctionSource(source);
    // Playwright invokes the page function only when typeof is "function" and
    // ships String(pageFunction) as its source.
    expect(typeof pageFunction).toBe('function');
    expect(String(pageFunction)).toBe(source);
  });
});
