import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeReadFile } from '@agent/core';

const ROOT = process.cwd();

function read(relPath: string): string {
  return String(safeReadFile(path.join(ROOT, relPath), { encoding: 'utf8' }) || '');
}

describe('run_baseline_check customer overlay contract', () => {
  it('reads customer-aware profile paths for readiness checks', () => {
    const script = read('scripts/run_baseline_check.ts');
    expect(script).toContain('customerResolver.customerRoot');
    expect(script).toContain("profileRoot()");
    expect(script).toContain("path.join(profileRoot(), 'connections'");
    expect(script).toContain("path.join(profileRoot(), 'my-identity.json')");
  });
});
