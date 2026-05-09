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
    const quickstart = read('docs/QUICKSTART.md');
    const ux = read('docs/OPERATOR_UX_GUIDE.md');
    const cli = read('scripts/cli.ts');
    const dashboard = read('scripts/sovereign_dashboard.ts');
    const localDev = read('docs/developer/LOCAL_DEV.md');

    expect(wizard).toContain('Set up a customer overlay now?');
    expect(wizard).toContain('customer_create');
    expect(wizard).toContain('customer_switch');
    expect(readme).toContain('pnpm customer:switch acme-corp');
    expect(operator).toContain('pnpm customer:create customer-slug');
    expect(operator).toContain('interactive identity setup → customer/{slug}/ (fallback: knowledge/personal/)');
    expect(operator).toContain('/app/customer');
    expect(init).toContain('customer/{slug}/my-identity.json');
    expect(init).toContain('`KYBERION_CUSTOMER` 未設定時は `knowledge/personal/my-identity.json`');
    expect(quickstart).toContain('customer/{slug}/ preferred when KYBERION_CUSTOMER is set');
    expect(ux).toContain('customer overlay material goes in `customer/{slug}/connections/` when `KYBERION_CUSTOMER` is set');
    expect(cli).toContain('customer/{slug}/ preferred when KYBERION_CUSTOMER is set');
    expect(dashboard).toContain('customer/{slug}/ preferred when KYBERION_CUSTOMER is set');
    expect(localDev).toContain('Customer-specific identity, connections, and onboarding artifacts resolve under customer/{slug}/ when set');
  });
});
