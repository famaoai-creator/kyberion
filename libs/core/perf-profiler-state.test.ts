import { describe, expect, it } from 'vitest';
import { parsePerformanceProfiles } from '../../plugins/perf-profiler.js';

describe('performance profiler state boundary', () => {
  it('keeps valid profiles and normalizes missing averages', () => {
    expect(
      parsePerformanceProfiles({
        build: { times: [10, 12] },
        test: { times: [8], avg: 8 },
      })
    ).toEqual({
      build: { times: [10, 12], avg: 0 },
      test: { times: [8], avg: 8 },
    });
  });

  it('skips malformed roots and individual profiles', () => {
    expect(parsePerformanceProfiles([])).toEqual({});
    expect(
      parsePerformanceProfiles({
        broken: { times: ['slow'] },
        nested: ['invalid'],
        healthy: { times: [1], avg: Number.NaN },
      })
    ).toEqual({ healthy: { times: [1], avg: 0 } });
  });
});
