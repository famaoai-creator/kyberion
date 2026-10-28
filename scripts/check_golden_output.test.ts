import { describe, expect, it } from 'vitest';
import { normalizeGoldenOutputResult } from './check_golden_output.js';

describe('golden output journal identity normalization', () => {
  it('ignores only the ephemeral engine run ID, preserving semantic outcomes and nested data', () => {
    const base = {
      status: 'succeeded',
      results: [{ op: 'system:log', status: 'success' }],
      context: { runId: 'meaningful-channel', receipt: { status: 'failed' } },
    };
    expect(normalizeGoldenOutputResult({ ...base, runId: 'one' }, [])).toEqual(base);
    expect(normalizeGoldenOutputResult({ ...base, runId: 'two' }, [])).toEqual(base);
    expect(
      normalizeGoldenOutputResult({ ...base, status: 'failed', runId: 'one' }, [])
    ).not.toEqual(base);
  });
});
