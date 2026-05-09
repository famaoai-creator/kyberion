import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeReadFile } from '@agent/core';

const rootDir = process.cwd();

function read(relPath: string): string {
  return safeReadFile(path.join(rootDir, relPath), { encoding: 'utf8' }) as string;
}

describe('Customer overlay use cases contract', () => {
  it('documents the customer overlay story and operational commands', () => {
    const doc = read('docs/user/customer-overlay-use-cases.md');
    const readme = read('docs/user/README.md');
    const customerReadme = read('customer/README.md');

    expect(doc).toContain('Customer Overlay Use Cases');
    expect(doc).toContain('create a customer overlay from the template');
    expect(doc).toContain('inspect which customer overlays are present and whether the required files are filled in');
    expect(doc).toContain('switch the active customer only after the overlay is ready');
    expect(doc).toContain('pnpm customer:create <slug>');
    expect(doc).toContain('pnpm customer:migrate-from-personal <slug>');
    expect(doc).toContain('pnpm customer:list');
    expect(doc).toContain('pnpm customer:switch <slug>');
    expect(doc).toContain('pnpm onboard');
    expect(doc).toContain('pnpm doctor');
    expect(doc).toContain('Unset `KYBERION_CUSTOMER`');
    expect(readme).toContain('customer-overlay-use-cases.md');
    expect(customerReadme).toContain('customer.json / identity.json / vision.md files are present');
  });
});
