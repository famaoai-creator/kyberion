import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeReadFile } from '@agent/core';

const rootDir = process.cwd();

function read(relPath: string): string {
  return safeReadFile(path.join(rootDir, relPath), { encoding: 'utf8' }) as string;
}

describe('Stance use cases contract', () => {
  it('documents the stance story and operational commands', () => {
    const doc = read('docs/user/customer-overlay-use-cases.md');
    const readme = read('docs/user/README.md');
    const customerReadme = read('templates/stance/README.md');

    expect(doc).toContain('# Stance Use Cases');
    expect(doc).toContain('create a stance from the template and declare `acting_for`');
    expect(doc).toContain(
      'inspect which stances are present and whether the required files are filled in'
    );
    expect(doc).toContain('a tenant they are not permitted to serve is rejected');
    expect(doc).toContain('retired');
    expect(doc).toContain('pnpm stance:create <slug>');
    expect(doc).toContain('pnpm stance:migrate-from-personal <slug>');
    expect(doc).toContain('pnpm stance:list');
    expect(doc).toContain('pnpm stance:switch <slug>');
    expect(doc).toContain('pnpm onboarding');
    expect(doc).toContain('pnpm kyberion doctor');
    expect(doc).toContain('Unset `KYBERION_STANCE`');
    expect(readme).toContain('customer-overlay-use-cases.md');
    expect(customerReadme).toContain('stance.json / identity.json files are present');
  });
});
