import { describe, expect, it } from 'vitest';
import { scanFileForKanaLiterals } from '../../scripts/check_i18n_hardcoding.js';
import { pathResolver, safeReadFile } from './index.js';

const graphConsumerPaths = [
  'libs/core/work-graph-projection.ts',
  'libs/core/mission-workitem-dispatch.ts',
  'libs/core/mission-work-reconciliation.ts',
  'libs/core/coordinated-agent-execution-port.ts',
  'scripts/sovereign_dashboard.ts',
];

describe('Work Graph i18n boundary', () => {
  it('keeps new Work Graph operator messages free of hardcoded Kana literals', () => {
    for (const relativePath of graphConsumerPaths) {
      const report = scanFileForKanaLiterals(
        String(safeReadFile(pathResolver.rootResolve(relativePath), { encoding: 'utf8' })),
        relativePath
      );
      expect(report, relativePath).toEqual({ count: 0, exemptions: 0 });
    }
  });

  it('does not increase the pre-existing virtual-office localization baseline', () => {
    const relativePath = 'scripts/virtual_office.ts';
    const report = scanFileForKanaLiterals(
      String(safeReadFile(pathResolver.rootResolve(relativePath), { encoding: 'utf8' })),
      relativePath
    );
    const baseline = JSON.parse(
      String(
        safeReadFile(pathResolver.rootResolve('knowledge/product/governance/i18n-baseline.json'), {
          encoding: 'utf8',
        })
      )
    ) as { files?: Record<string, number> };
    expect(report.count).toBe(baseline.files?.[relativePath]);
  });
});
