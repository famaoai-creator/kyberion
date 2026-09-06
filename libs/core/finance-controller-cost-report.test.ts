import { afterEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeRmSync, safeSymlinkSync, safeWriteFile } from './secure-io.js';
import { loadFinanceControllerCostReportAtPath } from './finance-controller-cost-report.js';

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

  it('rejects symlinked reports before JSON read', () => {
    const outside = path.join(root, 'outside');
    const link = path.join(root, 'report.json');
    safeMkdir(outside, { recursive: true });
    safeWriteFile(path.join(outside, 'real.json'), JSON.stringify({ total_usd: 1.25 }));
    safeSymlinkSync(path.join(outside, 'real.json'), link);

    expect(() => loadFinanceControllerCostReportAtPath(link)).toThrow('[RESOURCE_PATH_SYMLINK]');
  });
});
