import { describe, expect, it } from 'vitest';
import { checkCiGateParity } from './check_ci_gate_parity.js';

describe('CI gate parity', () => {
  it('keeps manifest scopes connected to their workflow entrypoints', () => {
    expect(checkCiGateParity()).toEqual([]);
  });
});
