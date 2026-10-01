// Retired 2026-10-01 with error-codes.ts (moved out of libs/core/core.test.ts).
import { describe, expect, it } from 'vitest';
import { ERROR_CODES, KyberionError } from './error-codes.js';

describe('error-codes', () => {
  it('should have structured fields in SkillError', () => {
    const err = new KyberionError(ERROR_CODES.VALIDATION_ERROR, 'bad input');
    expect(err.code).toBe('E200');
    expect(err.retryable).toBe(false);
    expect(err.message).toContain('bad input');
  });

  it('should serialize SkillError to JSON', () => {
    const err = new KyberionError(ERROR_CODES.EXECUTION_ERROR, 'timeout', {
      context: { s: 't' },
    });
    const json = err.toJSON();
    expect(json.code).toBe('E300');
    expect(json.retryable).toBe(true);
    expect(json.context.s).toBe('t');
  });
});
