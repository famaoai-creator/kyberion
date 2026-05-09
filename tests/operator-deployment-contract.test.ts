import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeReadFile } from '@agent/core';

const rootDir = process.cwd();

function read(relPath: string): string {
  return safeReadFile(path.join(rootDir, relPath), { encoding: 'utf8' }) as string;
}

describe('Operator deployment contract', () => {
  it('uses customer commands in the FDE deployment path', () => {
    const doc = read('docs/operator/DEPLOYMENT.md');
    expect(doc).toContain('pnpm customer:create customer-slug');
    expect(doc).toContain('pnpm customer:switch customer-slug');
    expect(doc).toContain('source active/shared/runtime/customer.env');
    expect(doc).not.toContain('cp -R customer/_template customer/customer-slug');
  });
});
