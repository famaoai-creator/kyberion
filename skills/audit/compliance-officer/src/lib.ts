import * as fs from 'node:fs';
import * as path from 'node:path';

export function auditCompliance(dir: string, patterns: string[]): any {
  const findings: any[] = [];
  for (const p of patterns) {
    const fullPath = path.join(dir, p);
    const exists = fs.existsSync(fullPath);

    // FISC / Security Enhanced Logic
    let status = exists ? 'compliant' : 'gap';
    let detail = exists ? 'Requirement met.' : 'FISC / Security Standard violation.';

    if (p === '.env') {
      status = exists ? 'critical_failure' : 'compliant';
      detail = exists
        ? 'CRITICAL: Raw secrets exposed in project root!'
        : 'Compliant: No secrets found in source.';
    }

    if (p.includes('kms') || p.includes('vault')) {
      detail = exists
        ? 'Infrastructure encryption configured.'
        : 'FISC Requirement: Data at rest encryption missing.';
    }

    findings.push({
      pattern: p,
      status,
      detail,
      timestamp: new Date().toISOString(),
    });
  }
  return findings;
}
