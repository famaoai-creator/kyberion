import { describe, expect, it } from 'vitest';
import { findMissingOpInputContractCoverage } from './check_op_input_contract_coverage.js';

describe('check_op_input_contract_coverage', () => {
  it('keeps contract-backed ops present in discovery with schemas and examples', () => {
    expect(findMissingOpInputContractCoverage()).toEqual([]);
  });
});
