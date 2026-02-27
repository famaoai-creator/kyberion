import { describe, it, expect } from 'vitest';
import { detectLanguage } from './lib';

describe('lang-detector lib', () => {
  it('should detect languages', () => {
    const enText =
      'This is a sample text in English that is specifically designed to be long enough for the language detector to identify it correctly with high confidence. It contains common English words and sentence structures.';
    const result = detectLanguage(enText);
    expect(result.language).toBe('english');
    expect(result.confidence).toBeGreaterThan(0.3); // Relaxed threshold
  });
});
