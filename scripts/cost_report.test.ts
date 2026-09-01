import { describe, expect, it } from 'vitest';
import { main } from './cost_report.js';

describe('cost report entrypoint', () => {
  it('returns the report without writing or setting an exit code', () => {
    process.exitCode = undefined;

    const report = main(['node', 'cost_report.ts', '--last-days', '1', '--json']);

    expect(report).toMatchObject({
      since: expect.anything(),
      until: null,
      by_mission: expect.any(Array),
      by_cause: expect.any(Array),
    });
    expect(process.exitCode).toBeUndefined();
  });
});
