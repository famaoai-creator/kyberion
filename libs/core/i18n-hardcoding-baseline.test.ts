import { describe, expect, it } from 'vitest';
import { loadI18nHardcodingBaselineAtPath } from './i18n-hardcoding-baseline.js';
import { pathResolver } from './path-resolver.js';

describe('i18n hardcoding baseline loader', () => {
  it('loads the governed baseline through its schema contract', () => {
    const baseline = loadI18nHardcodingBaselineAtPath(
      pathResolver.knowledge('product/governance/i18n-baseline.json')
    );
    expect(baseline?.version).toBe(1);
    expect(baseline?.scan_roots.length).toBeGreaterThan(0);
  });

  it('returns null for a missing baseline', () => {
    expect(
      loadI18nHardcodingBaselineAtPath(
        pathResolver.sharedTmp('i18n-hardcoding-baseline/missing.json')
      )
    ).toBeNull();
  });

  it('rejects a directory at the baseline resource boundary', () => {
    expect(() =>
      loadI18nHardcodingBaselineAtPath(pathResolver.knowledge('product/governance'))
    ).toThrow('[I18N_BASELINE] baseline must be a regular file');
  });
});
