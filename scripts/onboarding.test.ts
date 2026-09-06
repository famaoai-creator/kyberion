import { describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { pathResolver, safeReadFile } from '@agent/core';
import { main } from './onboarding.js';

describe('onboarding facade', () => {
  it('routes company onboarding without entering the interactive wizard', async () => {
    const print = vi.fn();

    await main(
      [
        'company',
        '--vertical',
        'saas-product-company',
        '--slug',
        'review-company',
        '--name',
        'Review Company',
        '--goal',
        'Validate the onboarding facade',
        '--dry-run',
      ],
      print
    );

    expect(print).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'planned', writtenFiles: [] })
    );
  });

  it('routes company bootstrap list through the same namespace', async () => {
    const print = vi.fn();

    await main(['company', 'bootstrap', '--list'], print);

    expect(print).toHaveBeenCalledWith(expect.stringContaining('Available company verticals:'));
  });

  it('routes the non-interactive apply path through the same namespace', async () => {
    await expect(
      main([
        'apply',
        '--identity',
        'active/shared/tmp/missing-onboarding-identity.json',
        '--dry-run',
      ])
    ).rejects.toThrow('identity file not found');
  });

  it('forwards apply output to the facade printer', async () => {
    const print = vi.fn();

    await main(
      [
        'apply',
        '--identity',
        'knowledge/public/templates/onboarding/identity.example.json',
        '--dry-run',
      ],
      print
    );

    expect(print).toHaveBeenCalledWith(expect.stringContaining('"status": "validated"'));
  });

  it('keeps reset preview output on the facade printer', async () => {
    const print = vi.fn();

    await main(['reset', '--dry-run', '--json'], print);

    expect(print).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
  });

  it('keeps the wizard on the shared printer boundary', () => {
    const source = String(
      safeReadFile(path.join(pathResolver.rootDir(), 'scripts/onboarding_wizard.ts'), {
        encoding: 'utf8',
      }) || ''
    );

    expect(source).not.toContain('console.log');
    expect(source).not.toContain('console.error');
    expect(source).toContain('run: ({ argv, print }) => runOnboarding(argv, print)');
  });
});
