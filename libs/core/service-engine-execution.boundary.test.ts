import { describe, expect, it } from 'vitest';
import { parseServiceCliOutput } from './service-engine-execution.js';

describe('service CLI output boundary', () => {
  it('parses a valid JSON object', () => {
    expect(parseServiceCliOutput('{"status":"ok","value":1}')).toEqual({
      status: 'ok',
      value: 1,
    });
  });

  it('retains conservative repair for benign malformed output', () => {
    expect(parseServiceCliOutput("prefix {status: 'ok',} suffix")).toEqual({ status: 'ok' });
  });

  it('does not promote dangerous objects into structured output', () => {
    const parsed = parseServiceCliOutput('{"__proto__":{"polluted":true}}');
    expect(typeof parsed).toBe('string');
    expect(parsed).toContain('__proto__');
  });
});
