import { describe, expect, it } from 'vitest';
import {
  findMissingOpInputContractCoverage,
  findOpInputContractViolations,
} from './check_op_input_contract_coverage.js';

describe('check_op_input_contract_coverage', () => {
  it('keeps contract-backed ops present in discovery with schemas and examples', () => {
    expect(findMissingOpInputContractCoverage()).toEqual([]);
  });

  it('rejects only unbounded legacy-open envelopes and counts inferred contracts', () => {
    expect(
      findOpInputContractViolations({
        actuators: [
          {
            n: 'fixture',
            ops: [
              {
                op: 'open',
                input_schema: {
                  type: 'object',
                  additionalProperties: true,
                  'x-kyberion-contract': 'legacy-open',
                },
                examples: [{}],
              },
              {
                op: 'legacy',
                input_schema: {
                  type: 'object',
                  additionalProperties: false,
                  'x-kyberion-contract': 'inferred-legacy',
                },
                examples: [{}],
              },
            ],
          },
        ],
      })
    ).toEqual(['fixture:open: legacy-open input contract is not permitted']);
  });
});
