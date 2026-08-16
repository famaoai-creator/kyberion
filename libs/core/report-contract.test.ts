import { describe, expect, it } from 'vitest';
import { executeReportContract } from './report-contract.js';

describe('pipeline report contract', () => {
  it('validates a report after the perform phase', async () => {
    let calls = 0;
    const result = await executeReportContract(
      {
        delegateTask: async () => {
          calls += 1;
          return calls === 1 ? '{"approve":"yes"}' : '{"approve":true,"gaps":[]}';
        },
      },
      { schema_ref: 'planning_review_verdict', use_judge: true },
      'Report the completed operation.'
    );

    expect(result).toEqual({ approve: true, gaps: [] });
    expect(calls).toBe(2);
  });

  it('rejects schema references outside the product schema boundary', async () => {
    await expect(
      executeReportContract(
        { delegateTask: async () => '{}' },
        { schema_ref: '../secret.json' },
        'Report the completed operation.'
      )
    ).rejects.toThrow(/REPORT_SCHEMA_INVALID/);
  });
});
