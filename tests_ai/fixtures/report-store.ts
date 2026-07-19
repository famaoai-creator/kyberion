/**
 * AI-audit fixture (KC-05). This file is audited by
 * tests_ai/fixture-error-message-guidance.md and DELIBERATELY contains one
 * violation so the audit layer provably reports a failure. Do not "fix" the
 * planted violation — failing here is the specification.
 *
 * Not part of any build: tsconfig only compiles scripts/presence/satellites,
 * and nothing imports this module.
 */

/** Compliant: names the offending input and tells the caller what to do. */
export function loadReport(reportPath: string): string {
  if (!reportPath.endsWith('.json')) {
    throw new Error(
      `Cannot load report from ${reportPath}: expected a .json file. ` +
        'Pass the report.json produced by pnpm ai-test.'
    );
  }
  return reportPath;
}

/** PLANTED VIOLATION: bare message — no offending input, no recovery guidance. */
export function saveReport(reportPath: string, data: string): void {
  if (!reportPath.endsWith('.json') || data.length === 0) {
    throw new Error('failed');
  }
}
