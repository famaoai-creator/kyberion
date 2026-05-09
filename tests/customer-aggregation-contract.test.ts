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
    expect(jp).toContain('[x] `pnpm customer:create`');
    expect(customerReadme).toContain('pnpm customer:create acme-corp');
  });
});
