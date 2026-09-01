import { describe, expect, it } from 'vitest';
import { checkEsmIntegrity } from './check_esm_integrity.js';

describe('ESM integrity checker', () => {
  it('keeps the governed source tree ESM-compatible', () => {
    expect(checkEsmIntegrity()).toEqual([]);
  }, 60_000);
});
