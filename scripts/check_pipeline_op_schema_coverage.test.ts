import { describe, expect, it } from 'vitest';
import { scanPipelineOpSchemas } from './check_pipeline_op_schema_coverage.js';

describe('check_pipeline_op_schema_coverage', () => {
  it('resolves whole-value templates before validating typed params', () => {
    const report = scanPipelineOpSchemas(
      {
        actuators: [
          {
            n: 'system-actuator',
            ops: [
              {
                op: 'probe',
                input_schema: {
                  type: 'object',
                  required: ['recursive'],
                  properties: { recursive: { type: 'boolean' } },
                  additionalProperties: false,
                },
              },
            ],
          },
        ],
      },
      [
        {
          path: 'fixture.json',
          value: { steps: [{ op: 'system:probe', params: { recursive: '{{flag}}' } }] },
        },
      ]
    );
    expect(report.violations).toEqual([]);
    expect(report.checked).toBe(1);
  });

  it('does not apply closed schemas to inferred-legacy operations', () => {
    const report = scanPipelineOpSchemas(
      {
        actuators: [
          {
            n: 'system-actuator',
            ops: [
              {
                op: 'legacy',
                input_schema: {
                  type: 'object',
                  additionalProperties: true,
                  'x-kyberion-contract': 'inferred-legacy',
                },
              },
            ],
          },
        ],
      },
      [
        {
          path: 'fixture.json',
          value: { steps: [{ op: 'system:legacy', params: { extra: true } }] },
        },
      ]
    );
    expect(report.violations).toEqual([]);
    expect(report.checked).toBe(0);
  });
});
