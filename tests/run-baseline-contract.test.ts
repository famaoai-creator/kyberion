import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeReadFile } from '@agent/core';

const ROOT = process.cwd();

function read(relPath: string): string {
  return String(safeReadFile(path.join(ROOT, relPath), { encoding: 'utf8' }) || '');
}

describe('run_baseline_check connection readiness contract', () => {
  it('uses the secret guard for profile connections and keeps identity customer-aware', () => {
    const script = read('scripts/run_baseline_check.ts');
    const identity = read('scripts/lib/installed-identity.ts');
    // Identity uses the customer-aware profile resolver in the installation helper, while
    // connection documents must go through secretGuard for encrypted-at-rest
    // handling and sensitive-path mediation.
    expect(script).toContain('inspectInstalledIdentity()');
    expect(identity).toContain('resolveActiveProfileRoot');
    expect(identity).toContain("inspectIdentity(['my-identity.json'])");
    expect(identity).toContain('requiredFiles.filter(');
    expect(identity).toContain('path.join(resolveActiveProfileRoot(), name)');
    expect(identity).toContain('KYBERION_CUSTOMER: scope.customer_stance');
    expect(script).toContain('secretGuard.loadConnectionDocument(serviceId)');
    expect(script).not.toContain("path.join(profileRoot(), 'connections'");
  });
});
