import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';
import { runOrganizationOperatingModelCli } from './organization_operating_model.js';

describe('organization operating model output boundary', () => {
  it('routes CLI output through the harness printer', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/organization_operating_model.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).not.toContain('console.log');
    expect(source).not.toContain('console.error');
    expect(source).toContain(
      'run: ({ argv, print }) => runOrganizationOperatingModelCli(argv, print)'
    );
  });

  it('uses the injected printer for help output', () => {
    const output: unknown[] = [];
    runOrganizationOperatingModelCli(['help'], (value) => output.push(value));
    expect(output).toHaveLength(1);
    expect(String(output[0])).toContain('pnpm organization model');
  });
});
