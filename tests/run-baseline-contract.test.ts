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
    // Identity still uses resolveActiveProfileRoot() via profileRoot(), while
    // connection documents must go through secretGuard for encrypted-at-rest
    // handling and sensitive-path mediation.
    expect(script).toContain('resolveActiveProfileRoot');
    expect(script).toContain('profileRoot()');
    expect(script).toContain("path.join(profileRoot(), 'my-identity.json')");
    expect(script).toContain('secretGuard.loadConnectionDocument(serviceId)');
    expect(script).not.toContain("path.join(profileRoot(), 'connections'");
  });
});
