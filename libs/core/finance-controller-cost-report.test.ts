import { afterEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeRmSync, safeSymlinkSync, safeWriteFile } from './secure-io.js';
import {
  financeControllerCostCoverage,
  loadFinanceControllerCostReportAtPath,
} from './finance-controller-cost-report.js';

const root = pathResolver.sharedTmp(`finance-controller-cost-report-${process.pid}`);

afterEach(() => {
  safeRmSync(root, { recursive: true, force: true });
});

describe('finance controller cost report loader', () => {
  it('loads legacy and cost-report aliases through one schema boundary', () => {
    const legacyFile = path.join(root, 'legacy.json');
    const reportFile = path.join(root, 'report.json');
    safeMkdir(root, { recursive: true });
    safeWriteFile(legacyFile, JSON.stringify({ totals: { total_tokens: 12 } }));
    safeWriteFile(reportFile, JSON.stringify({ total_usd: 1.25 }));

    expect(loadFinanceControllerCostReportAtPath(legacyFile)).toMatchObject({
      totals: { total_tokens: 12 },
    });
    expect(loadFinanceControllerCostReportAtPath(reportFile)).toEqual({ total_usd: 1.25 });
  });

  it('rejects malformed report envelopes', () => {
    const file = path.join(root, 'invalid.json');
    safeMkdir(root, { recursive: true });
    safeWriteFile(file, JSON.stringify({ unexpected: true }));

    expect(() => loadFinanceControllerCostReportAtPath(file)).toThrow(
      /Invalid catalog finance-controller-cost-report/u
    );
  });

  it('preserves unknown/included coverage and keeps reference estimates separate', () => {
    const file = path.join(root, 'coverage.json');
    safeMkdir(root, { recursive: true });
    const report = {
      total_usd: 0,
      reference_usd: 0.8,
      reference_cost_calls: 2,
      included_calls: 1,
      unknown_cost_calls: 1,
      cost_complete: false,
    };
    safeWriteFile(file, JSON.stringify(report));
    const loaded = loadFinanceControllerCostReportAtPath(file)!;
    expect(loaded).toEqual(report);
    expect(financeControllerCostCoverage(loaded)).toEqual({
      costComplete: false,
      unknownCostCalls: 1,
      includedCalls: 1,
      referenceCostUsd: 0.8,
      referenceCostCalls: 2,
    });
    expect(financeControllerCostCoverage({ unknown_cost_calls: 1 })).toMatchObject({
      costComplete: false,
    });
    expect(financeControllerCostCoverage({ total_usd: 1 })).toEqual({});
  });

  it.each([
    { reference_usd: -1 },
    { unknown_cost_calls: '1' },
    { included_calls: 0.5 },
    { cost_complete: 'true' },
    { cost_complete: true, unknown_cost_calls: 1 },
  ])('rejects malformed optional accounting metadata before finance consumes it %j', (patch) => {
    const file = path.join(root, 'malformed-coverage.json');
    safeMkdir(root, { recursive: true });
    safeWriteFile(file, JSON.stringify({ total_usd: 0, ...patch }));
    expect(() => loadFinanceControllerCostReportAtPath(file)).toThrow(
      'FINANCE_CONTROLLER_COST_REPORT'
    );
    safeWriteFile(file, JSON.stringify({ totals: { total_usd: 0, ...patch } }));
    expect(() => loadFinanceControllerCostReportAtPath(file)).toThrow(
      'FINANCE_CONTROLLER_COST_REPORT'
    );
  });

  it('rejects contradictory coverage envelopes instead of hiding a nested unknown subtotal', () => {
    const file = path.join(root, 'conflicting-coverage.json');
    safeMkdir(root, { recursive: true });
    for (const nested of [
      { cost_complete: false, unknown_cost_calls: 2 },
      { cost_complete: true, unknown_cost_calls: 0, reference_usd: 0.5 },
    ]) {
      safeWriteFile(
        file,
        JSON.stringify({
          total_usd: 0,
          cost_complete: true,
          unknown_cost_calls: 0,
          reference_usd: 0.4,
          summary: { total_usd: 0, ...nested },
        })
      );
      expect(() => loadFinanceControllerCostReportAtPath(file)).toThrow(
        'Conflicting accounting field'
      );
    }
  });

  it('rejects symlinked reports before JSON read', () => {
    const outside = path.join(root, 'outside');
    const link = path.join(root, 'report.json');
    safeMkdir(outside, { recursive: true });
    safeWriteFile(path.join(outside, 'real.json'), JSON.stringify({ total_usd: 1.25 }));
    safeSymlinkSync(path.join(outside, 'real.json'), link);

    expect(() => loadFinanceControllerCostReportAtPath(link)).toThrow('[RESOURCE_PATH_SYMLINK]');
  });
});
