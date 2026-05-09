import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeReadFile } from '@agent/core';

const rootDir = process.cwd();

function read(relPath: string): string {
  return safeReadFile(path.join(rootDir, relPath), { encoding: 'utf8' }) as string;
}

describe('Customer onboarding contract', () => {
  it('offers customer overlay setup in the onboarding wizard and docs', () => {
    const wizard = read('scripts/onboarding_wizard.ts');
    const readme = read('customer/README.md');
    const operator = read('docs/operator/DEPLOYMENT.md');
    const init = read('docs/INITIALIZATION.md');

    expect(wizard).toContain('Set up a customer overlay now?');
    expect(wizard).toContain('customer_create');
    expect(wizard).toContain('customer_switch');
    expect(readme).toContain('pnpm customer:switch acme-corp');
    expect(operator).toContain('pnpm customer:create customer-slug');
    expect(operator).toContain('interactive identity setup → customer/{slug}/ (fallback: knowledge/personal/)');
    expect(operator).toContain('/app/customer');
    expect(init).toContain('customer/{slug}/my-identity.json');
    expect(init).toContain('`KYBERION_CUSTOMER` 未設定時は `knowledge/personal/my-identity.json`');
  });
});
