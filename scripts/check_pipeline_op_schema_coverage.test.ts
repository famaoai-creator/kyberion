import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';
import { scanPipelineOpSchemas } from './check_pipeline_op_schema_coverage.js';

describe('check_pipeline_op_schema_coverage', () => {
  it('uses the governed persisted pipeline JSON loader', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/check_pipeline_op_schema_coverage.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).toContain('readSafeJsonValueFile');
    expect(source).not.toContain('readJson(safeFile)');
  });

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
