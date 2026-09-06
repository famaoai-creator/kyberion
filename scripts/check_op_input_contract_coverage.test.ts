import { describe, expect, it } from 'vitest';
import { safeReadFile } from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';
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

  it('keeps coverage warnings behind the injected printer', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/check_op_input_contract_coverage.ts'))
    );

    expect(source).toContain('print: (value: unknown) => void');
    expect(source).not.toContain('console.warn');
  });
});
