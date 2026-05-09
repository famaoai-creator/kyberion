import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeReadFile } from '@agent/core';

const rootDir = process.cwd();

function read(relPath: string): string {
  return safeReadFile(path.join(rootDir, relPath), { encoding: 'utf8' }) as string;
}

describe('Customer aggregation contract', () => {
  it('documents customer:create as an available command', () => {
    const doc = read('docs/developer/CUSTOMER_AGGREGATION.md');
    const jp = read('docs/developer/CUSTOMER_AGGREGATION.ja.md');
    const customerReadme = read('customer/README.md');
    expect(doc).toContain('pnpm customer:create <slug>');
    expect(doc).toContain('[x] CLI: `pnpm customer:create <slug>`');
    expect(doc).toContain('[x] CLI: `pnpm customer:list`');
    expect(doc).toContain('[x] CLI: `pnpm customer:switch <slug>`');
    expect(doc).toContain('[x] Migration helper: `pnpm customer:migrate-from-personal`');
    expect(doc).toContain('[x] Connections consumer (`libs/core/service-engine.ts`)');
    expect(doc).toContain('[x] Policy consumer (`libs/core/approval-policy.ts`)');
    expect(doc).toContain('[x] Mission seeds consumer (`libs/core/mission-seed-registry.ts`)');
    expect(jp).toContain('[x] `pnpm customer:create`');
    expect(jp).toContain('[x] `customer:list`');
    expect(jp).toContain('[x] `customer:switch`');
    expect(jp).toContain('[x] 移行ヘルパ');
    expect(customerReadme).toContain('pnpm customer:create acme-corp');
    expect(customerReadme).toContain('pnpm customer:list');
    expect(customerReadme).toContain('pnpm customer:migrate-from-personal acme-corp');
    expect(customerReadme).toContain('pnpm customer:switch acme-corp');
  });
});
