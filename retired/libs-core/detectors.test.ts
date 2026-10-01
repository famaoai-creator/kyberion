import { describe, expect, it } from 'vitest';

import { detectFormat } from './detectors.js';

describe('detectFormat', () => {
  it('recognizes valid JSON with full confidence', () => {
    expect(detectFormat('{"kind":"report"}')).toEqual({ format: 'json', confidence: 1 });
  });

  it('does not classify malformed JSON as JSON', () => {
    expect(detectFormat('{"kind":')).not.toEqual({ format: 'json', confidence: 1 });
  });

  it('does not classify JSON containing dangerous keys as JSON', () => {
    expect(detectFormat('{"__proto__":{"polluted":true}}')).not.toEqual({
      format: 'json',
      confidence: 1,
    });
  });
});
